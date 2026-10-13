//! Notification devices: `GET /v1/devices`, `POST /v1/devices` and `POST /v1/devices/{id}/remove`, as
//! apps/worker/src/notifications/service.ts (`listDevices`, `registerDevice`, `removeDevice`).
//!
//! Only the registration is ported. Nothing is delivered: the APNs dispatcher (provider key, HTTP/2 to
//! Apple, the durable notification effects the daily service and the assistant queue) is not ported, so
//! `deliveryConfigured` is always false and `lastDeliveryAt` always null. The token is kept so a later
//! dispatcher has it; it is never returned by any route.
//!
//! Storage: one record, `devices`, holding every registered device of the owner; it is its own commit
//! guard, so two registrations that read the same record never both commit.

use ferrite_app::serde_json::{self, json, Map, Value};

use crate::api::Store;
use crate::ledger::CmdError;
use crate::time::instant;

const KEY: &[u8] = b"devices";
/// The most devices this server keeps (TypeScript sets no bound; one owner has few phones).
pub const MAX_DEVICES: usize = 20;
const ATTEMPTS: usize = 3;

#[derive(Debug, Clone, PartialEq)]
struct Device {
    device_id: String,
    environment: String,
    /// The APNs token, lower-case hexadecimal.
    token: String,
    updated_at: String,
}

impl Device {
    fn to_json(&self) -> Value {
        json!({"deviceId": self.device_id, "environment": self.environment, "token": self.token, "updatedAt": self.updated_at})
    }
    fn from_json(v: &Value) -> Option<Device> {
        let s = |k: &str| v.get(k).and_then(Value::as_str).map(str::to_string);
        let d = Device { device_id: s("deviceId")?, environment: s("environment")?, token: s("token")?, updated_at: s("updatedAt")? };
        (device_id_ok(&d.device_id) && token_ok(&d.token) && ENVIRONMENTS.contains(&d.environment.as_str())).then_some(d)
    }
    /// `Device` in the contract: never the token.
    fn view(&self) -> Value {
        json!({"deviceId": self.device_id, "environment": self.environment, "status": "active", "disabledReason": null, "updatedAt": self.updated_at, "lastDeliveryAt": null})
    }
}

const ENVIRONMENTS: [&str; 2] = ["development", "production"];

/// `DeviceRegistration.deviceId` is 8 to 128 characters. This port also keeps it to the characters a
/// path segment carries unchanged (letters, digits, `-`, `.`, `_`, `~`), since it is named in
/// `POST /v1/devices/{id}/remove`; the app's IDs (`device-<uuid>`) are of that form.
fn device_id_ok(id: &str) -> bool {
    (8..=128).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_alphanumeric() || b"-._~".contains(&b))
}

/// `/^[0-9a-fA-F]{32,200}$/`.
fn token_ok(token: &str) -> bool {
    (32..=200).contains(&token.len()) && token.bytes().all(|b| b.is_ascii_hexdigit())
}

fn internal(message: &str) -> CmdError {
    CmdError::with("internal", message, json!({"retryable": true}))
}

fn corrupt() -> CmdError {
    CmdError::with("internal", "the stored notification devices are unreadable; nothing was changed", json!({"retryable": false}))
}

async fn read<S: Store>(store: &mut S) -> Result<(Option<Vec<u8>>, Vec<Device>), CmdError> {
    let bytes = store.get(KEY).await.map_err(|_| internal("the notification devices could not be read just now; try again"))?;
    let devices = match &bytes {
        None => Vec::new(),
        Some(b) => {
            let v: Value = serde_json::from_slice(b).map_err(|_| corrupt())?;
            if v["v"] != 1 {
                return Err(corrupt());
            }
            v["devices"].as_array().ok_or_else(corrupt)?.iter().map(Device::from_json).collect::<Option<Vec<_>>>().ok_or_else(corrupt)?
        }
    };
    Ok((bytes, devices))
}

/// Write `devices` if the record is still `old`; `false` when another request changed it first.
async fn write<S: Store>(store: &mut S, old: Option<&[u8]>, devices: &[Device]) -> Result<bool, CmdError> {
    let record = json!({"v": 1, "devices": devices.iter().map(Device::to_json).collect::<Vec<_>>()}).to_string();
    match store.commit_n_if(KEY, old, &[(KEY, record.as_bytes())]).await {
        Ok(Ok(())) => Ok(true),
        Ok(Err(_)) => Ok(false),
        Err(_) => Err(internal("the notification devices could not be saved just now; try again")),
    }
}

/// `GET /v1/devices` (`DeviceList`): the owner's devices, the most recently registered first.
pub async fn list<S: Store>(store: &mut S) -> Result<Value, CmdError> {
    let (_, mut devices) = read(store).await?;
    devices.sort_by(|a, b| b.updated_at.cmp(&a.updated_at).then_with(|| a.device_id.cmp(&b.device_id)));
    Ok(json!({"deliveryConfigured": false, "devices": devices.iter().map(Device::view).collect::<Vec<_>>()}))
}

fn invalid(message: impl Into<String>) -> CmdError {
    CmdError::new("invalid_command", message)
}

fn parse_registration(body: &[u8]) -> Result<(String, String, String), CmdError> {
    let m: Map<String, Value> = match serde_json::from_slice::<Value>(body) {
        Ok(Value::Object(m)) => m,
        Ok(_) => return Err(invalid("the request body must be a JSON object")),
        Err(_) => return Err(invalid("the request body is not valid JSON")),
    };
    if let Some(k) = m.keys().find(|k| !["deviceId", "token", "environment"].contains(&k.as_str())) {
        return Err(invalid(format!("'{k}' is not a field of a device registration")));
    }
    let device_id = match m.get("deviceId") {
        Some(Value::String(s)) if device_id_ok(s) => s.clone(),
        _ => return Err(invalid("deviceId: expected 8 to 128 letters, digits, '-', '.', '_' or '~'")),
    };
    let token = match m.get("token") {
        Some(Value::String(s)) if token_ok(s) => s.to_ascii_lowercase(),
        // As notifications/service.ts says it.
        _ => return Err(invalid("that is not a device token")),
    };
    let environment = match m.get("environment") {
        Some(Value::String(s)) if ENVIRONMENTS.contains(&s.as_str()) => s.clone(),
        _ => return Err(invalid("environment: expected development or production")),
    };
    Ok((device_id, token, environment))
}

/// `POST /v1/devices` (`DeviceRegistration` → `Device`): register or refresh this device. A token
/// registered under another device ID moves to this one (one phone, one registration).
pub async fn register<S: Store>(store: &mut S, now_ms: u64, body: &[u8]) -> Result<Value, CmdError> {
    let (device_id, token, environment) = parse_registration(body)?;
    let updated_at = instant(now_ms);
    for _ in 0..ATTEMPTS {
        let (old, mut devices) = read(store).await?;
        devices.retain(|d| d.device_id != device_id && d.token != token);
        if devices.len() >= MAX_DEVICES {
            return Err(CmdError::with(
                "precondition_failed",
                format!("this server keeps at most {MAX_DEVICES} notification devices; remove one first. Nothing was registered"),
                json!({"limit": MAX_DEVICES}),
            ));
        }
        devices.push(Device { device_id: device_id.clone(), environment: environment.clone(), token: token.clone(), updated_at: updated_at.clone() });
        if write(store, old.as_deref(), &devices).await? {
            return Ok(json!({"deviceId": device_id, "environment": environment, "status": "active", "updatedAt": updated_at}));
        }
    }
    Err(CmdError::with("conflict", "the notification devices kept changing; try again", json!({"retryable": true})))
}

/// The device ID of `POST /v1/devices/{id}/remove`, if the path is one.
pub fn remove_target(path: &str) -> Option<&str> {
    let id = path.strip_prefix("/v1/devices/")?.strip_suffix("/remove")?;
    (!id.is_empty() && !id.contains('/')).then_some(id)
}

/// `POST /v1/devices/{id}/remove` (`DeviceRemoved`): `removed` says whether there was one to remove.
pub async fn remove<S: Store>(store: &mut S, device_id: &str) -> Result<Value, CmdError> {
    for _ in 0..ATTEMPTS {
        let (old, mut devices) = read(store).await?;
        let before = devices.len();
        devices.retain(|d| d.device_id != device_id);
        if devices.len() == before {
            return Ok(json!({"removed": false}));
        }
        if write(store, old.as_deref(), &devices).await? {
            return Ok(json!({"removed": true}));
        }
    }
    Err(CmdError::with("conflict", "the notification devices kept changing; try again", json!({"retryable": true})))
}
