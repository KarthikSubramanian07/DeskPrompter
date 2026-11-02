//! Pure, host-testable relay logic: routing, validation, admission, limits and
//! control frames. Nothing in here touches the Workers runtime, so `cargo test
//! -p relay` exercises it on the host target.

use serde::{Deserialize, Serialize};

/// Room codes avoid look-alikes (no 0/O, 1/I/L) so they survive being read aloud
/// or typed from a laptop screen. Must match `apps/web/src/link/code.ts`.
pub const ROOM_CODE_ALPHABET: &str = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
pub const ROOM_CODE_LEN: usize = 6;

/// Largest text frame the relay will forward, in bytes.
pub const MAX_FRAME_BYTES: usize = 16 * 1024;
/// At most one host plus this many remotes/displays per room.
pub const MAX_GUESTS: usize = 6;
/// Sustained per-socket message rate and burst allowance.
pub const RATE_PER_SEC: f64 = 60.0;
pub const RATE_BURST: f64 = 60.0;
/// A room with no relayed traffic for this long is closed (clients reconnect on demand).
pub const IDLE_MS: f64 = 60.0 * 60.0 * 1000.0;
/// Persist "last active" at most this often to keep storage writes cheap.
pub const PERSIST_EVERY_MS: f64 = 60.0 * 1000.0;

/// Heartbeat pair answered by the runtime itself (does not wake a hibernating room).
pub const PING: &str = r#"{"t":"ping"}"#;
pub const PONG: &str = r#"{"t":"pong"}"#;

/// Application close codes (4000-4999 are reserved for applications).
pub mod close {
    /// Another socket with the same peer id (or a newer host) took this slot.
    pub const REPLACED: u16 = 4000;
    pub const BAD_REQUEST: u16 = 4400;
    pub const ROOM_FULL: u16 = 4409;
    pub const IDLE: u16 = 4408;
    pub const RATE_LIMITED: u16 = 4429;
    pub const UNSUPPORTED: u16 = 1003;
}

/// Frame types only the relay may emit; clients sending these are dropped.
const RESERVED_TYPES: &[&str] = &["peer", "peers", "err", "ping", "pong"];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    Host,
    Remote,
    Display,
}

impl Role {
    pub fn parse(s: &str) -> Option<Role> {
        match s {
            "host" => Some(Role::Host),
            "remote" => Some(Role::Remote),
            "display" => Some(Role::Display),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Role::Host => "host",
            Role::Remote => "remote",
            Role::Display => "display",
        }
    }
}

/// Uppercases and validates a room code. Returns `None` for anything that is not
/// exactly six characters from [`ROOM_CODE_ALPHABET`].
pub fn normalize_room_code(raw: &str) -> Option<String> {
    let code = raw.trim().to_ascii_uppercase();
    if code.len() != ROOM_CODE_LEN {
        return None;
    }
    if code.chars().all(|c| ROOM_CODE_ALPHABET.contains(c)) {
        Some(code)
    } else {
        None
    }
}

/// Peer ids are chosen by clients (stable per tab, so a reload replaces its own
/// stale socket). 4..=24 chars of `[A-Za-z0-9_-]`.
pub fn valid_peer_id(raw: &str) -> bool {
    (4..=24).contains(&raw.len()) && raw.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// Builds a peer id from a random source (each call should return a fresh random u32).
pub fn generate_peer_id(mut rand: impl FnMut() -> u32) -> String {
    const ALPHA: &[u8] = b"abcdefghijkmnpqrstuvwxyz23456789";
    (0..10).map(|_| ALPHA[(rand() as usize) % ALPHA.len()] as char).collect()
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RoomRequest {
    pub code: String,
    pub role: Role,
    pub id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Route {
    Health,
    Preflight,
    Room(RoomRequest),
    BadRequest(&'static str),
    MethodNotAllowed,
    NotFound,
}

fn query_param<'a>(query: Option<&'a str>, key: &str) -> Option<&'a str> {
    query?.split('&').find_map(|pair| {
        let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
        (k == key).then_some(v)
    })
}

/// Maps a request onto a [`Route`]. `path` excludes the query string.
pub fn route(method: &str, path: &str, query: Option<&str>) -> Route {
    let path = path.trim_end_matches('/');
    if method == "OPTIONS" {
        return Route::Preflight;
    }
    if path == "/health" || path.is_empty() {
        return if method == "GET" || method == "HEAD" { Route::Health } else { Route::MethodNotAllowed };
    }
    let Some(raw_code) = path.strip_prefix("/room/") else {
        return Route::NotFound;
    };
    if method != "GET" {
        return Route::MethodNotAllowed;
    }
    if raw_code.contains('/') {
        return Route::NotFound;
    }
    let Some(code) = normalize_room_code(raw_code) else {
        return Route::BadRequest("invalid room code");
    };
    let Some(role) = query_param(query, "role").and_then(Role::parse) else {
        return Route::BadRequest("role must be host, remote or display");
    };
    let id = match query_param(query, "id") {
        None | Some("") => None,
        Some(id) if valid_peer_id(id) => Some(id.to_string()),
        Some(_) => return Route::BadRequest("invalid peer id"),
    };
    Route::Room(RoomRequest { code, role, id })
}

/// Who may open a room socket: the production site, its preview deployments,
/// and local development (localhost, loopback and private LAN addresses so a
/// phone on the same Wi-Fi can reach `vite --host`).
pub fn origin_allowed(origin: Option<&str>) -> bool {
    let Some(origin) = origin else { return false };
    if origin == "https://deskprompter.pages.dev" {
        return true;
    }
    if let Some(host) = origin.strip_prefix("https://") {
        if let Some(sub) = host.strip_suffix(".deskprompter.pages.dev") {
            return !sub.is_empty() && sub.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-');
        }
        return false;
    }
    let Some(rest) = origin.strip_prefix("http://") else { return false };
    let host = match rest.rsplit_once(':') {
        Some((h, p)) if !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()) => h,
        Some(_) => return false,
        None => rest,
    };
    if host == "localhost" || host == "127.0.0.1" || host == "[::1]" {
        return true;
    }
    is_private_ipv4(host)
}

fn is_private_ipv4(host: &str) -> bool {
    let octets: Vec<u8> = match host.split('.').map(|p| p.parse::<u8>()).collect::<Result<_, _>>() {
        Ok(o) => o,
        Err(_) => return false,
    };
    match octets.as_slice() {
        [10, _, _, _] => true,
        [192, 168, _, _] => true,
        [172, b, _, _] => (16..=31).contains(b),
        _ => false,
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Peer {
    pub id: String,
    pub role: Role,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Admission {
    /// Accept; the listed indices (into `existing`) must be closed as replaced.
    Accept { replace: Vec<usize> },
    Full,
}

/// Decides whether a new socket fits in the room. A socket reusing a live peer
/// id replaces it (tab reload / phone reconnect); a new host replaces the old
/// host; otherwise guests are capped at [`MAX_GUESTS`].
pub fn admit(existing: &[Peer], role: Role, id: &str) -> Admission {
    let replace: Vec<usize> = existing
        .iter()
        .enumerate()
        .filter(|(_, p)| p.id == id || (role == Role::Host && p.role == Role::Host))
        .map(|(i, _)| i)
        .collect();
    if role != Role::Host {
        let guests = existing
            .iter()
            .enumerate()
            .filter(|(i, p)| p.role != Role::Host && !replace.contains(i))
            .count();
        if guests >= MAX_GUESTS {
            return Admission::Full;
        }
    }
    Admission::Accept { replace }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FrameCheck {
    /// Forward it. `to` targets a single peer id; `None` broadcasts.
    Relay { to: Option<String> },
    TooBig,
    Invalid,
}

#[derive(Deserialize)]
struct Envelope {
    t: String,
    #[serde(default)]
    to: Option<String>,
}

/// Validates a client text frame: size cap, JSON object with a string `t`, not a
/// relay-reserved type. An optional string `to` routes it to one peer.
pub fn check_frame(text: &str) -> FrameCheck {
    if text.len() > MAX_FRAME_BYTES {
        return FrameCheck::TooBig;
    }
    match serde_json::from_str::<Envelope>(text) {
        Ok(env) if !env.t.is_empty() && !RESERVED_TYPES.contains(&env.t.as_str()) => FrameCheck::Relay { to: env.to },
        _ => FrameCheck::Invalid,
    }
}

/// Token bucket rate limiter, refilled continuously.
#[derive(Debug, Clone, PartialEq)]
pub struct TokenBucket {
    tokens: f64,
    last_ms: f64,
    /// Consecutive rejected messages; used to cut off abusive sockets.
    pub strikes: u32,
}

impl TokenBucket {
    pub fn new(now_ms: f64) -> Self {
        TokenBucket { tokens: RATE_BURST, last_ms: now_ms, strikes: 0 }
    }

    pub fn allow(&mut self, now_ms: f64) -> bool {
        let elapsed = (now_ms - self.last_ms).max(0.0) / 1000.0;
        self.tokens = (self.tokens + elapsed * RATE_PER_SEC).min(RATE_BURST);
        self.last_ms = now_ms;
        if self.tokens >= 1.0 {
            self.tokens -= 1.0;
            self.strikes = 0;
            true
        } else {
            self.strikes += 1;
            false
        }
    }

    /// True once a socket has ignored the limit for long enough to be closed.
    pub fn abusive(&self) -> bool {
        self.strikes > (RATE_PER_SEC as u32) * 5
    }
}

pub fn idle_expired(last_active_ms: f64, now_ms: f64) -> bool {
    now_ms - last_active_ms >= IDLE_MS
}

#[derive(Serialize)]
struct PeerFrame<'a> {
    t: &'static str,
    event: &'static str,
    role: Role,
    id: &'a str,
}

#[derive(Serialize)]
struct PeersFrame<'a> {
    t: &'static str,
    #[serde(rename = "self")]
    self_id: &'a str,
    role: Role,
    list: Vec<PeerEntry<'a>>,
}

#[derive(Serialize)]
struct PeerEntry<'a> {
    id: &'a str,
    role: Role,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PeerEvent {
    Join,
    Leave,
}

/// `{"t":"peer","event":"join"|"leave","role":"...","id":"..."}`
pub fn peer_frame(event: PeerEvent, role: Role, id: &str) -> String {
    let event = match event {
        PeerEvent::Join => "join",
        PeerEvent::Leave => "leave",
    };
    serde_json::to_string(&PeerFrame { t: "peer", event, role, id }).unwrap_or_default()
}

/// `{"t":"peers","self":"<your id>","role":"<your role>","list":[{"id","role"}...]}` sent to a
/// socket right after it joins; `list` holds everyone else.
pub fn peers_frame(self_id: &str, self_role: Role, others: &[Peer]) -> String {
    let list = others.iter().map(|p| PeerEntry { id: &p.id, role: p.role }).collect();
    serde_json::to_string(&PeersFrame { t: "peers", self_id, role: self_role, list }).unwrap_or_default()
}

/// `{"t":"err","code":"..."}` for frames the relay refused.
pub fn err_frame(code: &str) -> String {
    #[derive(Serialize)]
    struct ErrFrame<'a> {
        t: &'static str,
        code: &'a str,
    }
    serde_json::to_string(&ErrFrame { t: "err", code }).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn room_codes_validate_and_normalize() {
        assert_eq!(normalize_room_code("abc234").as_deref(), Some("ABC234"));
        assert_eq!(normalize_room_code("HJKMNP").as_deref(), Some("HJKMNP"));
        assert_eq!(normalize_room_code("ABC23"), None, "too short");
        assert_eq!(normalize_room_code("ABC2345"), None, "too long");
        for bad in ["ABC10O", "ABCDEI", "ABCDEL", "ABC-23", "ÄBC234", "      "] {
            assert_eq!(normalize_room_code(bad), None, "{bad} should be rejected");
        }
    }

    #[test]
    fn alphabet_has_no_lookalikes() {
        for c in ['0', 'O', '1', 'I', 'L'] {
            assert!(!ROOM_CODE_ALPHABET.contains(c));
        }
        assert_eq!(ROOM_CODE_ALPHABET.len(), 31);
    }

    #[test]
    fn peer_ids() {
        assert!(valid_peer_id("abcd"));
        assert!(valid_peer_id("Ab_9-xyz"));
        assert!(!valid_peer_id("abc"));
        assert!(!valid_peer_id(&"a".repeat(25)));
        assert!(!valid_peer_id("ab cd"));
        assert!(!valid_peer_id("ab%20cd"));
        let mut n = 0u32;
        let id = generate_peer_id(|| {
            n += 7;
            n
        });
        assert_eq!(id.len(), 10);
        assert!(valid_peer_id(&id));
    }

    #[test]
    fn routes() {
        assert_eq!(route("GET", "/health", None), Route::Health);
        assert_eq!(route("GET", "/", None), Route::Health);
        assert_eq!(route("OPTIONS", "/room/ABCDEF", None), Route::Preflight);
        assert_eq!(route("POST", "/health", None), Route::MethodNotAllowed);
        assert_eq!(route("GET", "/nope", None), Route::NotFound);
        assert_eq!(route("GET", "/room/ABCDEF/x", Some("role=host")), Route::NotFound);
        assert_eq!(
            route("GET", "/room/abcdef", Some("role=remote&id=phone-1")),
            Route::Room(RoomRequest { code: "ABCDEF".into(), role: Role::Remote, id: Some("phone-1".into()) })
        );
        assert_eq!(
            route("GET", "/room/ABCDEF/", Some("x=1&role=display")),
            Route::Room(RoomRequest { code: "ABCDEF".into(), role: Role::Display, id: None })
        );
        assert_eq!(route("GET", "/room/ABCDE0", Some("role=host")), Route::BadRequest("invalid room code"));
        assert!(matches!(route("GET", "/room/ABCDEF", None), Route::BadRequest(_)));
        assert!(matches!(route("GET", "/room/ABCDEF", Some("role=admin")), Route::BadRequest(_)));
        assert!(matches!(route("GET", "/room/ABCDEF", Some("role=host&id=a b")), Route::BadRequest(_)));
        assert_eq!(route("POST", "/room/ABCDEF", Some("role=host")), Route::MethodNotAllowed);
    }

    #[test]
    fn origins() {
        let ok = [
            "https://deskprompter.pages.dev",
            "https://feat-link.deskprompter.pages.dev",
            "https://3f2a1b.deskprompter.pages.dev",
            "http://localhost:5173",
            "http://localhost",
            "http://127.0.0.1:4173",
            "http://192.168.1.20:5173",
            "http://10.0.0.8:5173",
            "http://172.20.1.1:5173",
        ];
        for o in ok {
            assert!(origin_allowed(Some(o)), "{o} should be allowed");
        }
        let bad = [
            "https://evil.com",
            "https://deskprompter.pages.dev.evil.com",
            "https://evildeskprompter.pages.dev",
            "https://a.b.deskprompter.pages.dev",
            "http://deskprompter.pages.dev",
            "https://localhost:5173",
            "http://localhost.evil.com",
            "http://localhost:abc",
            "http://172.32.0.1:5173",
            "http://8.8.8.8",
            "null",
            "",
        ];
        for o in bad {
            assert!(!origin_allowed(Some(o)), "{o} should be rejected");
        }
        assert!(!origin_allowed(None));
    }

    fn peer(id: &str, role: Role) -> Peer {
        Peer { id: id.into(), role }
    }

    #[test]
    fn admission_caps_guests_and_replaces() {
        let mut room = vec![peer("host", Role::Host)];
        for i in 0..MAX_GUESTS {
            assert_eq!(admit(&room, Role::Remote, &format!("r{i}xx")), Admission::Accept { replace: vec![] });
            room.push(peer(&format!("r{i}xx"), Role::Remote));
        }
        assert_eq!(admit(&room, Role::Display, "new1"), Admission::Full);
        // A reconnecting guest replaces its own stale socket even when full.
        assert_eq!(admit(&room, Role::Remote, "r3xx"), Admission::Accept { replace: vec![4] });
        // A new host always gets in and replaces the old one.
        assert_eq!(admit(&room, Role::Host, "host2"), Admission::Accept { replace: vec![0] });
        assert_eq!(admit(&[], Role::Host, "h1h1"), Admission::Accept { replace: vec![] });
    }

    #[test]
    fn frames_are_size_and_shape_checked() {
        assert_eq!(check_frame(r#"{"t":"cmd","c":"toggle"}"#), FrameCheck::Relay { to: None });
        assert_eq!(
            check_frame(r#"{"t":"sig","to":"abcd","sdp":{"type":"offer"}}"#),
            FrameCheck::Relay { to: Some("abcd".into()) }
        );
        let big = format!(r#"{{"t":"script","text":"{}"}}"#, "x".repeat(MAX_FRAME_BYTES));
        assert_eq!(check_frame(&big), FrameCheck::TooBig);
        let just_fits = format!(r#"{{"t":"x","p":"{}"}}"#, "x".repeat(MAX_FRAME_BYTES - 16));
        assert_eq!(just_fits.len(), MAX_FRAME_BYTES);
        assert_eq!(check_frame(&just_fits), FrameCheck::Relay { to: None });
        for bad in ["", "hello", "[]", "{}", r#"{"t":3}"#, r#"{"t":""}"#, r#"{"t":"peer","event":"join"}"#, r#"{"t":"pong"}"#] {
            assert_eq!(check_frame(bad), FrameCheck::Invalid, "{bad:?}");
        }
    }

    #[test]
    fn token_bucket_limits_rate() {
        let mut b = TokenBucket::new(0.0);
        let allowed = (0..200).filter(|_| b.allow(0.0)).count();
        assert_eq!(allowed, RATE_BURST as usize, "burst only at t=0");
        // Half a second later about 30 more tokens are available.
        let allowed = (0..200).filter(|_| b.allow(500.0)).count();
        assert_eq!(allowed, 30);
        // A steady 50 msg/s never trips the limiter.
        let mut b = TokenBucket::new(0.0);
        assert!((0..500).all(|i| b.allow(i as f64 * 20.0)));
        // Hammering eventually marks the socket abusive.
        let mut b = TokenBucket::new(0.0);
        for _ in 0..1000 {
            b.allow(0.0);
        }
        assert!(b.abusive());
        // Clock going backwards never mints tokens.
        let mut b = TokenBucket::new(10_000.0);
        let allowed = (0..200).filter(|_| b.allow(0.0)).count();
        assert_eq!(allowed, RATE_BURST as usize);
    }

    #[test]
    fn idle_rooms_expire() {
        assert!(!idle_expired(0.0, IDLE_MS - 1.0));
        assert!(idle_expired(0.0, IDLE_MS));
    }

    #[test]
    fn control_frames() {
        assert_eq!(
            peer_frame(PeerEvent::Join, Role::Remote, "abcd"),
            r#"{"t":"peer","event":"join","role":"remote","id":"abcd"}"#
        );
        assert_eq!(
            peer_frame(PeerEvent::Leave, Role::Host, "h1h1"),
            r#"{"t":"peer","event":"leave","role":"host","id":"h1h1"}"#
        );
        assert_eq!(
            peers_frame("me12", Role::Remote, &[peer("h1h1", Role::Host)]),
            r#"{"t":"peers","self":"me12","role":"remote","list":[{"id":"h1h1","role":"host"}]}"#
        );
        assert_eq!(peers_frame("me12", Role::Host, &[]), r#"{"t":"peers","self":"me12","role":"host","list":[]}"#);
        assert_eq!(err_frame("too_big"), r#"{"t":"err","code":"too_big"}"#);
    }
}
