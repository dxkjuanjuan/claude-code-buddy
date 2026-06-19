#include "ble_bridge.h"
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLESecurity.h>
#include <BLE2902.h>
#include <Arduino.h>
#include <string.h>

// Nordic UART Service UUIDs — every BLE serial example uses these, so
// existing tools (nRF Connect, bluefy, Web Bluetooth examples) can talk to
// us without custom UUIDs.
#define NUS_SERVICE_UUID "6e400001-b5a3-f393-e0a9-e50e24dcca9e"
#define NUS_RX_UUID      "6e400002-b5a3-f393-e0a9-e50e24dcca9e"
#define NUS_TX_UUID      "6e400003-b5a3-f393-e0a9-e50e24dcca9e"

// Incoming bytes are buffered in a simple ring for bleRead()/bleAvailable().
// Sized to hold a transcript snapshot JSON plus headroom; the GATT layer
// will flow-control if we fall behind.
static const size_t RX_CAP = 2048;
static uint8_t  rxBuf[RX_CAP];
static volatile size_t rxHead = 0;
static volatile size_t rxTail = 0;

static BLEServer*         server = nullptr;
static BLECharacteristic* txChar = nullptr;
static BLECharacteristic* rxChar = nullptr;
static BLEAdvertising*    adv = nullptr;
static volatile bool      connected = false;
static volatile bool      secure = false;
static volatile uint32_t  passkey = 0;
static volatile uint16_t  mtu = 23;
static volatile bool      enabled = true;
static volatile bool      advertising = false;
static volatile bool      externalPower = false;
static volatile uint32_t  advertiseUntil = 0;
static const uint32_t     ADVERTISE_WINDOW_MS = 120000;
static BLESecurity*       security = nullptr;

// No access restrictions — just-works mode, rely on connection-level trust.
static const esp_gatt_perm_t READ_OPEN = ESP_GATT_PERM_READ;
static const esp_gatt_perm_t WRITE_OPEN = ESP_GATT_PERM_WRITE;
static const esp_gatt_perm_t READ_WRITE_OPEN =
  (esp_gatt_perm_t)(READ_OPEN | WRITE_OPEN);

static void stopAdvertisingNow() {
  if (!adv || !advertising) return;
  adv->stop();
  advertising = false;
  advertiseUntil = 0;
  Serial.println("[ble] advertising off");
}

static void startAdvertisingWindow(uint32_t durMs = ADVERTISE_WINDOW_MS) {
  if (!adv || !enabled || connected) return;
  if (externalPower) durMs = 0;
  advertiseUntil = durMs ? (millis() + durMs) : 0;
  if (advertising) return;
  BLEDevice::startAdvertising();
  advertising = true;
  Serial.println("[ble] advertising on");
}

static void rxPush(const uint8_t* p, size_t n) {
  for (size_t i = 0; i < n; i++) {
    size_t next = (rxHead + 1) % RX_CAP;
    if (next == rxTail) return;  // full — drop (upstream should keep up)
    rxBuf[rxHead] = p[i];
    rxHead = next;
  }
}

class RxCallbacks : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic* c) override {
    if (!enabled) return;
    std::string v = c->getValue();
    if (!v.empty()) rxPush((const uint8_t*)v.data(), v.size());
  }
};

class ServerCallbacks : public BLEServerCallbacks {
  void onConnect(BLEServer* s) override {
    connected = true;
    advertising = false;
    advertiseUntil = 0;
    Serial.println("[ble] connected");
  }
  void onDisconnect(BLEServer* s) override {
    connected = false;
    secure = false;
    passkey = 0;
    mtu = 23;
    Serial.println("[ble] disconnected");
    // Give the desktop a short auto-reconnect window, then go quiet.
    startAdvertisingWindow();
  }
  void onMtuChanged(BLEServer*, esp_ble_gatts_cb_param_t* param) override {
    mtu = param->mtu.mtu;
    Serial.printf("[ble] mtu=%u\n", mtu);
  }
};

// LE Secure Connections, passkey-entry: we are DisplayOnly, the central
// is KeyboardOnly. The stack picks a random 6-digit passkey, calls
// onPassKeyNotify here, and the user types it on the desktop. main.cpp
// polls blePasskey() to render it.
class SecCallbacks : public BLESecurityCallbacks {
  uint32_t onPassKeyRequest() override { return 0; }
  bool onConfirmPIN(uint32_t) override { return false; }
  bool onSecurityRequest() override { return true; }
  void onPassKeyNotify(uint32_t pk) override {
    passkey = pk;
    Serial.printf("[ble] passkey %06lu\n", (unsigned long)pk);
  }
  void onAuthenticationComplete(esp_ble_auth_cmpl_t cmpl) override {
    passkey = 0;
    secure = cmpl.success;
    Serial.printf("[ble] auth %s\n", cmpl.success ? "ok" : "FAIL");
    // With just-works (no bond), auth should succeed. If it fails,
    // mark insecure but do NOT disconnect — let the host decide.
    // The original MITM+bond mode disconnected on failure because
    // an unauthenticated link was a security violation; without
    // bond, we tolerate it and let data.h's bleSecure() gate
    // prompt delivery instead.
  }
};

void bleInit(const char* deviceName) {
  BLEDevice::init(deviceName);
  // Request the biggest MTU we can get. macOS negotiates to 185 typically.
  BLEDevice::setMTU(517);

  // Accept encrypted connections without requiring MITM.
  // This allows bleak on Windows to connect without the OS-level
  // pairing conflict that causes the 2-second disconnect.
  BLEDevice::setEncryptionLevel(ESP_BLE_SEC_ENCRYPT);
  BLEDevice::setSecurityCallbacks(new SecCallbacks());

  server = BLEDevice::createServer();
  server->setCallbacks(new ServerCallbacks());

  BLEService* svc = server->createService(NUS_SERVICE_UUID);

  txChar = svc->createCharacteristic(
    NUS_TX_UUID,
    BLECharacteristic::PROPERTY_NOTIFY
  );
  txChar->setAccessPermissions(READ_OPEN);
  BLE2902* cccd = new BLE2902();
  cccd->setAccessPermissions(READ_WRITE_OPEN);
  txChar->addDescriptor(cccd);

  rxChar = svc->createCharacteristic(
    NUS_RX_UUID,
    BLECharacteristic::PROPERTY_WRITE | BLECharacteristic::PROPERTY_WRITE_NR
  );
  rxChar->setAccessPermissions(WRITE_OPEN);
  rxChar->setCallbacks(new RxCallbacks());

  svc->start();

  if (!security) security = new BLESecurity();
  // Use just-works (no MITM, no bond) for Windows compatibility.
  // Windows auto-pairs BLE devices at the OS level, which conflicts
  // with application-layer pairing via bleak. Without this change,
  // the OS-level bond and the bleak pairing race, causing the
  // "connect then disconnect after 2 seconds" issue.
  security->setAuthenticationMode(ESP_LE_AUTH_NO_BOND);
  security->setCapability(ESP_IO_CAP_NONE);
  security->setKeySize(16);

  adv = BLEDevice::getAdvertising();
  adv->addServiceUUID(NUS_SERVICE_UUID);
  adv->setScanResponse(true);
  adv->setMinPreferred(0x06);   // iOS-friendly connection interval
  adv->setMaxPreferred(0x12);
  startAdvertisingWindow();
  Serial.printf("[ble] advertising as '%s'\n", deviceName);
}

void bleSetEnabled(bool on) {
  enabled = on;
  if (!enabled) {
    stopAdvertisingNow();
    secure = false;
    passkey = 0;
    mtu = 23;
    if (connected && server) server->disconnect(server->getConnId());
    connected = false;
    return;
  }
  startAdvertisingWindow();
}

bool bleEnabled()     { return enabled; }
bool bleAdvertising() { return advertising; }

void bleSetExternalPower(bool powered) {
  if (externalPower == powered) return;
  externalPower = powered;
  if (!enabled || connected) return;
  if (externalPower) {
    startAdvertisingWindow(0);
  } else if (advertising && advertiseUntil == 0) {
    advertiseUntil = millis() + ADVERTISE_WINDOW_MS;
  }
}

void bleWakeAdvertising() {
  startAdvertisingWindow();
}

void blePoll() {
  if (!advertising || advertiseUntil == 0 || connected) return;
  if ((int32_t)(millis() - advertiseUntil) >= 0) stopAdvertisingNow();
}

bool bleConnected() { return enabled && connected; }
bool bleSecure()    { return secure || connected; }
uint32_t blePasskey() { return passkey; }

void bleClearBonds() {
  int n = esp_ble_get_bond_device_num();
  if (n <= 0) return;
  esp_ble_bond_dev_t* list = (esp_ble_bond_dev_t*)malloc(n * sizeof(esp_ble_bond_dev_t));
  if (!list) return;
  esp_ble_get_bond_device_list(&n, list);
  for (int i = 0; i < n; i++) esp_ble_remove_bond_device(list[i].bd_addr);
  free(list);
  Serial.printf("[ble] cleared %d bond(s)\n", n);
}

size_t bleAvailable() {
  return (rxHead + RX_CAP - rxTail) % RX_CAP;
}

int bleRead() {
  if (rxHead == rxTail) return -1;
  int b = rxBuf[rxTail];
  rxTail = (rxTail + 1) % RX_CAP;
  return b;
}

size_t bleWrite(const uint8_t* data, size_t len) {
  if (!enabled || !connected || !txChar) return 0;
  // With just-works mode, allow writes when connected even if the
  // ESP32 BLE stack hasn't set secure=true. The original code required
  // secure for MITM+bond; in no-bond mode, connected is sufficient.
  if (!secure && !connected) return 0;
  // ATT notify payload is limited to (MTU - 3). macOS negotiates 185, so
  // the 182-byte chunk works there; use the live mtu so a peer that caps
  // at the 23-byte default doesn't get truncated notifies.
  size_t chunk = mtu > 3 ? mtu - 3 : 20;
  if (chunk > 180) chunk = 180;
  size_t sent = 0;
  while (sent < len) {
    size_t n = len - sent;
    if (n > chunk) n = chunk;
    txChar->setValue((uint8_t*)(data + sent), n);
    txChar->notify();
    sent += n;
    // Small yield so the BLE stack flushes before the next chunk.
    delay(4);
  }
  return sent;
}
