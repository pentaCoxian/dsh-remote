//! C ABI for `dart:ffi`. Every call returns a JSON string the caller frees
//! with `dshr_string_free`: `{"ok":true,...}` or `{"ok":false,"error":"..."}`.
//! Calls block until done (dialing can take seconds), so Dart makes them from
//! a background isolate. Panics stop at this boundary and come back as errors.

use std::ffi::{c_char, CStr, CString};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::Path;
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, PoisonError};

use iroh::EndpointId;
use serde_json::{json, Value};
use tokio::runtime::Runtime;

use crate::{ticket_info, Pipes, Result, PUSH_ALPN};

fn runtime() -> &'static Runtime {
    static RUNTIME: OnceLock<Runtime> = OnceLock::new();
    RUNTIME.get_or_init(|| {
        tokio::runtime::Builder::new_multi_thread().worker_threads(2).thread_name("dshr").enable_all().build().expect("tokio runtime")
    })
}

fn pipes() -> &'static Mutex<Option<Arc<Pipes>>> {
    static PIPES: OnceLock<Mutex<Option<Arc<Pipes>>>> = OnceLock::new();
    PIPES.get_or_init(|| Mutex::new(None))
}

/// The slot, even after a panic elsewhere held its lock: the panic already came
/// back as an error, and the slot itself is always whole.
fn slot() -> MutexGuard<'static, Option<Arc<Pipes>>> {
    pipes().lock().unwrap_or_else(PoisonError::into_inner)
}

fn current() -> Result<Arc<Pipes>> {
    slot().clone().ok_or_else(|| "the transport is not started".to_string())
}

fn respond(body: impl FnOnce() -> Result<Value>) -> *mut c_char {
    let reply = match catch_unwind(AssertUnwindSafe(body)) {
        Ok(Ok(mut value)) => {
            if !value.is_object() {
                value = json!({ "value": value });
            }
            value["ok"] = json!(true);
            value
        }
        Ok(Err(error)) => json!({ "ok": false, "error": error }),
        Err(_) => json!({ "ok": false, "error": "internal error in the transport" }),
    };
    CString::new(reply.to_string()).expect("json has no NUL").into_raw()
}

/// # Safety
/// `text` must be null or a valid NUL-terminated string.
unsafe fn string(text: *const c_char, name: &str) -> Result<String> {
    if text.is_null() {
        return Err(format!("{name} is missing"));
    }
    unsafe { CStr::from_ptr(text) }.to_str().map(str::to_owned).map_err(|_| format!("{name} is not UTF-8"))
}

fn host_id(text: &str) -> Result<EndpointId> {
    text.parse::<EndpointId>().map_err(|e| format!("bad host id: {e}"))
}

/// Start the endpoint with the app's 32-byte iroh secret key and a JSON array of
/// relay URLs. Starting again while running returns the running endpoint's id.
///
/// # Safety
/// `secret_key` must point to `secret_len` bytes; `relays_json` must be a valid C string.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn dshr_start(secret_key: *const u8, secret_len: usize, relays_json: *const c_char) -> *mut c_char {
    respond(|| {
        if secret_key.is_null() || secret_len != 32 {
            return Err("the secret key must be 32 bytes".into());
        }
        let key: [u8; 32] = unsafe { std::slice::from_raw_parts(secret_key, 32) }.try_into().expect("32 bytes");
        let relays: Vec<String> = serde_json::from_str(&unsafe { string(relays_json, "relays") }?).map_err(|_| "relays must be a JSON array of URLs".to_string())?;
        let mut slot = slot();
        if let Some(running) = slot.as_ref() {
            return Ok(json!({ "endpointId": running.endpoint_id().to_string() }));
        }
        let started = Arc::new(runtime().block_on(Pipes::start(key, &relays))?);
        let id = started.endpoint_id().to_string();
        *slot = Some(started);
        Ok(json!({ "endpointId": id }))
    })
}

/// Dial the host named by `ticket` and serve it on the Unix socket `socket_path`.
///
/// # Safety
/// Both arguments must be valid C strings.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn dshr_open(ticket: *const c_char, socket_path: *const c_char) -> *mut c_char {
    respond(|| {
        let ticket = unsafe { string(ticket, "ticket") }?;
        let socket_path = unsafe { string(socket_path, "socket path") }?;
        let pipes = current()?;
        runtime().block_on(pipes.open(&ticket, Path::new(&socket_path)))
    })
}

/// Dial the push gateway named by `ticket` and serve it on the Unix socket `socket_path`.
/// It is then closed, and its status read, like a host (by its EndpointId).
///
/// # Safety
/// Both arguments must be valid C strings.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn dshr_open_gateway(ticket: *const c_char, socket_path: *const c_char) -> *mut c_char {
    respond(|| {
        let ticket = unsafe { string(ticket, "ticket") }?;
        let socket_path = unsafe { string(socket_path, "socket path") }?;
        let pipes = current()?;
        runtime().block_on(pipes.open_alpn(&ticket, Path::new(&socket_path), PUSH_ALPN))
    })
}

/// Stop serving one host.
///
/// # Safety
/// `host` must be a valid C string.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn dshr_close(host: *const c_char) -> *mut c_char {
    respond(|| {
        let host = host_id(&unsafe { string(host, "host id") }?)?;
        let pipes = current()?;
        Ok(json!({ "closed": runtime().block_on(pipes.close(host)) }))
    })
}

/// Serve one host's DSH Web tunnel on a 127.0.0.1 TCP port (`preferred_port` when free). -> {port}
///
/// # Safety
/// `host` must be a valid C string.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn dshr_open_web(host: *const c_char, preferred_port: u16) -> *mut c_char {
    respond(|| {
        let host = host_id(&unsafe { string(host, "host id") }?)?;
        let pipes = current()?;
        runtime().block_on(pipes.open_web(host, preferred_port))
    })
}

/// Stop one host's DSH Web tunnel. -> {closed}
///
/// # Safety
/// `host` must be a valid C string.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn dshr_close_web(host: *const c_char) -> *mut c_char {
    respond(|| {
        let host = host_id(&unsafe { string(host, "host id") }?)?;
        let pipes = current()?;
        Ok(json!({ "closed": runtime().block_on(pipes.close_web(host)) }))
    })
}

/// Connection details for one host: connected, paths (relay or direct, RTT), home relay.
///
/// # Safety
/// `host` must be a valid C string.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn dshr_status(host: *const c_char) -> *mut c_char {
    respond(|| {
        let host = host_id(&unsafe { string(host, "host id") }?)?;
        let pipes = current()?;
        Ok(runtime().block_on(pipes.status(host)))
    })
}

/// Hang up on one host and keep its pipe, so the next socket dials a new
/// connection (one that looked open but carried nothing).
///
/// # Safety
/// `host` must be a valid C string.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn dshr_reconnect(host: *const c_char) -> *mut c_char {
    respond(|| {
        let host = host_id(&unsafe { string(host, "host id") }?)?;
        let pipes = current()?;
        Ok(json!({ "reconnected": runtime().block_on(pipes.reconnect(host)) }))
    })
}

/// Close every pipe and keep the endpoint (the app going to the background).
/// Coming back reopens pipes on the same endpoint: a fresh one would share the
/// key with this one while it closes, and the relay would serve them by turns.
#[unsafe(no_mangle)]
pub extern "C" fn dshr_suspend() -> *mut c_char {
    respond(|| {
        let pipes = current()?;
        runtime().block_on(pipes.suspend());
        Ok(json!({}))
    })
}

/// What a ticket names, without dialing it.
///
/// # Safety
/// `ticket` must be a valid C string.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn dshr_ticket_info(ticket: *const c_char) -> *mut c_char {
    respond(|| ticket_info(&unsafe { string(ticket, "ticket") }?))
}

#[unsafe(no_mangle)]
pub extern "C" fn dshr_network_changed() -> *mut c_char {
    respond(|| {
        let pipes = current()?;
        runtime().block_on(pipes.network_changed());
        Ok(json!({}))
    })
}

/// Close every pipe and the endpoint (the app going to the background).
///
/// The lock is held until the endpoint is down, so a start that follows (the app
/// coming back) waits: two endpoints with the same key would fight over the relay
/// and the host's connection. A graceful close gets [`SHUTDOWN_LIMIT`].
#[unsafe(no_mangle)]
pub extern "C" fn dshr_stop() -> *mut c_char {
    respond(|| {
        let mut slot = slot();
        if let Some(pipes) = slot.take() {
            let _ = runtime().block_on(async { tokio::time::timeout(SHUTDOWN_LIMIT, pipes.shutdown()).await });
        }
        Ok(json!({}))
    })
}

const SHUTDOWN_LIMIT: std::time::Duration = std::time::Duration::from_secs(3);

/// # Safety
/// `text` must come from one of the functions above and be freed once.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn dshr_string_free(text: *mut c_char) {
    if !text.is_null() {
        drop(unsafe { CString::from_raw(text) });
    }
}

/// Android: hand the JavaVM and application context to native code once, so
/// iroh's interface monitor can use the Android APIs (netlink is restricted).
#[cfg(target_os = "android")]
#[unsafe(no_mangle)]
pub extern "system" fn Java_dev_dshremote_dsh_1remote_IrohPipe_nativeInit(env: jni::JNIEnv, _class: jni::objects::JClass, context: jni::objects::JObject) {
    let Ok(vm) = env.get_java_vm() else { return };
    let Ok(context) = env.new_global_ref(context) else { return };
    unsafe { ndk_context::initialize_android_context(vm.get_java_vm_pointer().cast(), context.as_obj().as_raw().cast()) };
    // The context must outlive every native call.
    std::mem::forget(context);
}
