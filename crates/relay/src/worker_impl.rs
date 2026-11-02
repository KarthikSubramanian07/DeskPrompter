//! Workers runtime glue: the fetch entry point and the `Room` Durable Object.

use std::cell::{Cell, RefCell};
use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use worker::*;

use crate::protocol::{self, close, Admission, FrameCheck, Peer, PeerEvent, Role, Route, TokenBucket};

const ROOMS_BINDING: &str = "ROOMS";
const LAST_ACTIVE_KEY: &str = "last";

fn now_ms() -> f64 {
    Date::now().as_millis() as f64
}

fn cors_headers() -> Result<Headers> {
    let headers = Headers::new();
    headers.set("Access-Control-Allow-Origin", "*")?;
    headers.set("Access-Control-Allow-Methods", "GET, OPTIONS")?;
    headers.set("Access-Control-Max-Age", "86400")?;
    headers.set("Cache-Control", "no-store")?;
    Ok(headers)
}

#[event(fetch)]
async fn fetch(req: Request, env: Env, _ctx: Context) -> Result<Response> {
    console_error_panic_hook::set_once();
    let url = req.url()?;
    match protocol::route(req.method().as_ref(), url.path(), url.query()) {
        Route::Health => Ok(Response::from_json(&serde_json::json!({
            "ok": true,
            "service": "deskprompter-relay",
            "version": env!("CARGO_PKG_VERSION"),
        }))?
        .with_headers(cors_headers()?)),
        Route::Preflight => Ok(Response::empty()?.with_status(204).with_headers(cors_headers()?)),
        Route::NotFound => Response::error("not found", 404),
        Route::MethodNotAllowed => Response::error("method not allowed", 405),
        Route::BadRequest(msg) => Response::error(msg, 400),
        Route::Room(room) => {
            let origin = req.headers().get("Origin")?;
            if !protocol::origin_allowed(origin.as_deref()) {
                return Response::error("origin not allowed", 403);
            }
            let upgrade = req.headers().get("Upgrade")?.unwrap_or_default();
            if !upgrade.eq_ignore_ascii_case("websocket") {
                return Response::error("expected a WebSocket upgrade", 426);
            }
            let stub = env.durable_object(ROOMS_BINDING)?.id_from_name(&room.code)?.get_stub()?;
            stub.fetch_with_request(req).await
        }
    }
}

/// Per-socket state that survives hibernation.
#[derive(Serialize, Deserialize, Clone, Debug)]
struct Attachment {
    id: String,
    role: Role,
    /// Set when the relay itself closed this socket (replaced / idle), so its
    /// close event does not announce a `leave` for a peer that is still here.
    #[serde(default)]
    gone: bool,
}

#[durable_object]
pub struct Room {
    state: State,
    /// Rate limiters keyed by peer id. In-memory only: after hibernation a
    /// socket simply starts with a full bucket again.
    buckets: RefCell<HashMap<String, TokenBucket>>,
    last_active: Cell<f64>,
    last_persist: Cell<f64>,
}

impl Room {
    fn live(&self) -> Vec<(WebSocket, Attachment)> {
        self.state
            .get_websockets()
            .into_iter()
            .filter_map(|ws| match ws.deserialize_attachment::<Attachment>() {
                Ok(Some(a)) if !a.gone => Some((ws, a)),
                _ => None,
            })
            .collect()
    }

    fn broadcast(&self, from_id: &str, text: &str) {
        for (ws, a) in self.live() {
            if a.id != from_id {
                let _ = ws.send_with_str(text);
            }
        }
    }

    async fn touch(&self) {
        let now = now_ms();
        self.last_active.set(now);
        if now - self.last_persist.get() >= protocol::PERSIST_EVERY_MS {
            self.last_persist.set(now);
            let _ = self.state.storage().put(LAST_ACTIVE_KEY, now).await;
        }
    }

    async fn ensure_alarm(&self) -> Result<()> {
        let storage = self.state.storage();
        if storage.get_alarm().await?.is_none() {
            storage.set_alarm((now_ms() + protocol::IDLE_MS) as i64).await?;
        }
        Ok(())
    }

    async fn on_gone(&self, ws: &WebSocket) -> Result<()> {
        let Some(mut a) = ws.deserialize_attachment::<Attachment>()? else {
            return Ok(());
        };
        if a.gone {
            return Ok(());
        }
        a.gone = true;
        let _ = ws.serialize_attachment(&a);
        self.buckets.borrow_mut().remove(&a.id);
        self.broadcast(&a.id, &protocol::peer_frame(PeerEvent::Leave, a.role, &a.id));
        // Complete the close handshake; harmless if the runtime already did.
        let _ = ws.close(Some(1000), Some("bye"));
        if self.live().is_empty() {
            let storage = self.state.storage();
            let _ = storage.delete_alarm().await;
            let _ = storage.delete_all().await;
        }
        Ok(())
    }
}

impl DurableObject for Room {
    fn new(state: State, _env: Env) -> Self {
        if let Ok(pair) = worker_sys::WebSocketRequestResponsePair::new(protocol::PING, protocol::PONG) {
            state.set_websocket_auto_response(&pair);
        }
        Room { state, buckets: RefCell::new(HashMap::new()), last_active: Cell::new(0.0), last_persist: Cell::new(0.0) }
    }

    async fn fetch(&self, req: Request) -> Result<Response> {
        let url = req.url()?;
        let Route::Room(request) = protocol::route("GET", url.path(), url.query()) else {
            return Response::error("bad request", 400);
        };
        let id = request.id.unwrap_or_else(|| protocol::generate_peer_id(|| (js_sys::Math::random() * u32::MAX as f64) as u32));
        let pair = WebSocketPair::new()?;

        let live = self.live();
        let peers: Vec<Peer> = live.iter().map(|(_, a)| Peer { id: a.id.clone(), role: a.role }).collect();
        let replace = match protocol::admit(&peers, request.role, &id) {
            Admission::Accept { replace } => replace,
            Admission::Full => {
                // Not hibernatable: accept just to deliver a readable close code.
                pair.server.accept()?;
                pair.server.close(Some(close::ROOM_FULL), Some("room full"))?;
                return Response::from_websocket(pair.client);
            }
        };

        for &i in &replace {
            let (ws, a) = &live[i];
            let mut a = a.clone();
            let id_reused = a.id == id;
            a.gone = true;
            let _ = ws.serialize_attachment(&a);
            let _ = ws.close(Some(close::REPLACED), Some("replaced"));
            self.buckets.borrow_mut().remove(&a.id);
            if !id_reused {
                // A different host took over: tell everyone the old one left.
                self.broadcast(&a.id, &protocol::peer_frame(PeerEvent::Leave, a.role, &a.id));
            }
        }

        let others: Vec<Peer> = peers.into_iter().enumerate().filter(|(i, _)| !replace.contains(i)).map(|(_, p)| p).collect();

        self.state.accept_web_socket(&pair.server);
        pair.server.serialize_attachment(&Attachment { id: id.clone(), role: request.role, gone: false })?;
        pair.server.send_with_str(protocol::peers_frame(&id, request.role, &others))?;
        self.broadcast(&id, &protocol::peer_frame(PeerEvent::Join, request.role, &id));

        self.touch().await;
        self.ensure_alarm().await?;
        Response::from_websocket(pair.client)
    }

    async fn websocket_message(&self, ws: WebSocket, message: WebSocketIncomingMessage) -> Result<()> {
        let Some(me) = ws.deserialize_attachment::<Attachment>()? else {
            return Ok(());
        };
        if me.gone {
            return Ok(());
        }
        let text = match message {
            WebSocketIncomingMessage::String(text) => text,
            WebSocketIncomingMessage::Binary(_) => {
                ws.close(Some(close::UNSUPPORTED), Some("text frames only"))?;
                return Ok(());
            }
        };

        let now = now_ms();
        let (allowed, abusive) = {
            let mut buckets = self.buckets.borrow_mut();
            let bucket = buckets.entry(me.id.clone()).or_insert_with(|| TokenBucket::new(now));
            let allowed = bucket.allow(now);
            (allowed, bucket.abusive())
        };
        if abusive {
            ws.close(Some(close::RATE_LIMITED), Some("rate limited"))?;
            return Ok(());
        }
        if !allowed {
            let _ = ws.send_with_str(protocol::err_frame("rate"));
            return Ok(());
        }

        match protocol::check_frame(&text) {
            FrameCheck::TooBig => {
                let _ = ws.send_with_str(protocol::err_frame("too_big"));
            }
            FrameCheck::Invalid => {
                let _ = ws.send_with_str(protocol::err_frame("invalid"));
            }
            FrameCheck::Relay { to } => {
                for (peer, a) in self.live() {
                    if a.id == me.id || to.as_deref().is_some_and(|t| t != a.id) {
                        continue;
                    }
                    let _ = peer.send_with_str(&text);
                }
                self.touch().await;
            }
        }
        Ok(())
    }

    async fn websocket_close(&self, ws: WebSocket, _code: usize, _reason: String, _was_clean: bool) -> Result<()> {
        self.on_gone(&ws).await
    }

    async fn websocket_error(&self, ws: WebSocket, _error: Error) -> Result<()> {
        self.on_gone(&ws).await
    }

    async fn alarm(&self) -> Result<Response> {
        let storage = self.state.storage();
        let live = self.live();
        if live.is_empty() {
            let _ = storage.delete_all().await;
            return Response::ok("empty");
        }
        let persisted = storage.get::<f64>(LAST_ACTIVE_KEY).await.ok().flatten().unwrap_or(0.0);
        let last = self.last_active.get().max(persisted);
        let now = now_ms();
        if protocol::idle_expired(last, now) {
            for (ws, mut a) in live {
                a.gone = true;
                let _ = ws.serialize_attachment(&a);
                let _ = ws.close(Some(close::IDLE), Some("idle"));
            }
            self.buckets.borrow_mut().clear();
            let _ = storage.delete_all().await;
            return Response::ok("closed idle room");
        }
        storage.set_alarm((last + protocol::IDLE_MS) as i64).await?;
        Response::ok("still active")
    }
}
