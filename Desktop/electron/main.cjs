const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, screen, session } = require("electron");
const path = require("node:path");
const { guidance, validRect } = require("../shared/visibility.cjs");
const { pathToFileURL } = require("node:url");
const root = path.resolve(__dirname, "..");
let panel, stage, overlay, tray, target, quitting = false, generation = 0;
let state = { status: "idle", collapsed: false, text: "시연을 골라 플로팅 창의 동작을 확인하세요." };
let blockedRequests = 0, layoutVersion = 0, connection;
const delay = Math.min(3000, Math.max(300, Number(process.env.DESKTOP_DEMO_DELAY_MS) || 1000));
const indexUrl = pathToFileURL(path.join(root, "dist/index.html")).href;
app.commandLine.appendSwitch("disable-background-networking");
app.commandLine.appendSwitch("disable-component-update");

function protect(window) {
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", event => event.preventDefault());
  window.webContents.on("will-attach-webview", event => event.preventDefault());
}
function options(extra = {}) {
  return { show: false, autoHideMenuBar: true, ...extra, webPreferences: {
    preload: path.join(__dirname, "preload.cjs"), nodeIntegration: false,
    contextIsolation: true, sandbox: true, webSecurity: true,
  } };
}
function publish(update = {}) {
  state = { ...state, ...update };
  if (panel && !panel.isDestroyed()) panel.webContents.send("panel:state", state);
  return state;
}
function clearHighlight() { generation++; overlay?.hide(); }
function hidePanel() {
  connection?.hidden();
  clearHighlight();
  if (state.status === "waiting") publish({ status: "idle", text: "시연을 중지했습니다. 다시 선택해 주세요." });
  panel.hide();
}
function showPanel() { connection?.manualOpen(); panel.showInactive(); updateHighlight(); }
function clampPanel() {
  const bounds = panel.getBounds();
  const area = screen.getDisplayMatching(bounds).workArea;
  panel.setBounds({ ...bounds, x: Math.max(area.x, Math.min(bounds.x, area.x + area.width - bounds.width)),
    y: Math.max(area.y, Math.min(bounds.y, area.y + area.height - bounds.height)) });
}
function collapse() {
  publish({ collapsed: !state.collapsed });
  connection?.collapsed(state.collapsed);
  if (state.collapsed) {
    clearHighlight();
    if (state.status === "waiting") publish({ status: "idle", text: "시연을 중지했습니다. 다시 선택해 주세요." });
  }
  const area = screen.getDisplayMatching(panel.getBounds()).workArea;
  panel.setSize(Math.min(380, area.width), state.collapsed ? 76 : Math.min(560, area.height));
  clampPanel();
  return state;
}
function updateHighlight() {
  if (!overlay) return;
  if (connection && connection.mode !== "demo") return connection.renderHighlight();
  if (quitting || !stage || stage.isDestroyed() || state.status !== "guide" || state.collapsed || !panel.isVisible()) return overlay.hide();
  const result = guidance({target,content:stage.getContentBounds(),zoom:stage.webContents.getZoomFactor(),
    displays:screen.getAllDisplays().map(display => display.workArea),
    panelBounds:panel.isVisible()?panel.getBounds():null,
    active:stage.isVisible() && !stage.isMinimized() && stage.isFocused()});
  if (state.text !== result.text || state.visibility !== result.kind) publish({text:result.text,visibility:result.kind});
  if (result.kind !== "visible") return overlay.hide();
  const rect = result.rect;
  overlay.setBounds({x:Math.round(rect.x-8),y:Math.round(rect.y-28),width:Math.ceil(rect.width+16),height:Math.ceil(rect.height+36)});
  if (!overlay.isVisible()) overlay.showInactive();
}
function requestMeasurement() {
  target = null; layoutVersion++; overlay.hide();
  if (stage && !stage.isDestroyed()) stage.webContents.send("stage:measure",layoutVersion);
  updateHighlight();
}
async function openStage() {
  if (stage && !stage.isDestroyed()) { stage.showInactive(); return; }
  const area = screen.getDisplayMatching(panel.getBounds()).workArea;
  stage = new BrowserWindow(options({ title: "곁에 · 가상 서비스 연습 화면", useContentSize: true,
    x: area.x + 20, y: area.y + 40, width: Math.min(760, area.width - 40), height: Math.min(540, area.height - 80) }));
  protect(stage);
  stage.on("move", updateHighlight);
  stage.on("resize", requestMeasurement);
  stage.webContents.on("zoom-changed",requestMeasurement);
  stage.webContents.setVisualZoomLevelLimits(1,1);
  stage.on("restore",requestMeasurement);
  stage.on("hide", updateHighlight);
  stage.on("minimize", updateHighlight);
  stage.on("closed", () => { stage = null; target = null; clearHighlight(); publish({ status: "idle", text: "연습 화면을 닫았습니다. 다시 시연할 수 있습니다." }); });
  stage.on("blur", checkFocus);
  stage.on("focus", updateHighlight);
  await stage.loadFile(path.join(root, "dist/index.html"), { query: { stage: "true" } });
  stage.showInactive();
}
function checkFocus() {
  overlay.hide();
  updateHighlight();
  setTimeout(() => { if (!quitting) updateHighlight(); },80);
}
async function guide() {
  clearHighlight();
  const current = generation;
  publish({ status: "waiting", text: "가상 화면의 정해진 버튼 위치를 준비하고 있습니다. 실제 인식이 아닙니다." });
  try { await openStage(); }
  catch {
    if (current === generation) publish({ status: "error", text: "연습 화면을 준비하지 못했습니다. 다시 시도해 주세요." });
    return state;
  }
  await new Promise(resolve => setTimeout(resolve, delay));
  if (current !== generation || quitting) return state;
  publish({ status: "guide", text: "연습 화면의 버튼 표시 상태를 확인합니다." });
  updateHighlight();
  return state;
}
function trusted(event, window) {
  return window && !window.isDestroyed() && event.sender === window.webContents
    && event.senderFrame === window.webContents.mainFrame
    && event.senderFrame.url.split("?")[0] === indexUrl;
}
function trayIcon() {
  const size = 32, bitmap = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const inside = (x - 15.5) ** 2 + (y - 15.5) ** 2 < 225;
    const mark = (y >= 9 && y <= 12 && x >= 9 && x <= 22) || (x >= 19 && x <= 22 && y >= 9 && y <= 23);
    const i = (y * size + x) * 4;
    bitmap[i] = bitmap[i+1] = bitmap[i+2] = mark ? 255 : 30;
    bitmap[i+3] = inside ? 255 : 0;
  }
  return nativeImage.createFromBitmap(bitmap, { width: size, height: size });
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", showPanel);
  app.on("before-quit", () => { quitting = true; connection?.stop(); clearHighlight(); });
  app.on("window-all-closed", () => {});
  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);
    app.setAppUserModelId("org.welfare-helper.gyeote.desktop");
    session.defaultSession.setPermissionRequestHandler((_web, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    // 네트워크 요청은 메인에서 차단하고, 렌더러 CSP도 connect-src 'none'으로 제한한다.
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
      const allowed = details.url.startsWith("file://");
      if (!allowed) blockedRequests++;
      callback({ cancel: !allowed });
    });
    const area = screen.getPrimaryDisplay().workArea;
    panel = new BrowserWindow(options({ title: "곁에 · 로컬 UI 시연", frame: false, alwaysOnTop: true,
      skipTaskbar: true, resizable: false, width: Math.min(380, area.width), height: Math.min(560, area.height),
      x: area.x + Math.max(0, area.width - 404), y: area.y + Math.max(0, area.height - 584) }));
    protect(panel);
    panel.on("close", event => { if (!quitting) { event.preventDefault(); hidePanel(); } });
    panel.on("blur", checkFocus);
    panel.on("focus", updateHighlight);
    panel.on("move",updateHighlight);
    panel.on("resize",updateHighlight);
    overlay = new BrowserWindow({ show: false, transparent: true, frame: false, focusable: false,
      skipTaskbar: true, alwaysOnTop: true, resizable: false, hasShadow: false,
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } });
    protect(overlay);
    overlay.setIgnoreMouseEvents(true);
    overlay.setAlwaysOnTop(true, "screen-saver");
    ipcMain.handle("panel:command", async (event, action, payload) => {
      if (!trusted(event, panel)) throw new Error("허용되지 않은 창입니다.");
      if (connection && ["mode","goal","advance","rag","reset"].includes(action)) {
        await connection.command(action,payload); return state;
      }
      if (connection && connection.mode !== "demo" && ["guide","error"].includes(action)) throw new Error("개발 시연 모드를 먼저 선택하세요.");
      if (action === "guide") return guide();
      if (action === "collapse") { const result = collapse(); updateHighlight(); return result; }
      if (action === "hide") hidePanel();
      else if (action === "reset" || action === "error") {
        clearHighlight(); publish({ status: action === "error" ? "error" : "idle",
          text: action === "error" ? "로컬 오류 시연입니다. 화면을 판단할 수 없을 때 안내를 멈추고 다시 확인합니다." : "초기화했습니다. 다시 시연을 선택하세요." });
      } else if (action === "state") publish();
      else throw new Error("알 수 없는 동작입니다.");
      return state;
    });
    ipcMain.handle("stage:version", event => {
      if (!trusted(event,stage)) throw new Error("허용되지 않은 창입니다.");
      return layoutVersion;
    });
    ipcMain.on("stage:target", (event, packet) => {
      if (!trusted(event,stage) || !packet || packet.version !== layoutVersion) return;
      if (!validRect(packet.rect) || !validRect(packet.viewport) || !packet.clip
          || ![packet.clip.x,packet.clip.y,packet.clip.width,packet.clip.height].every(Number.isFinite)
          || packet.clip.width < 0 || packet.clip.height < 0 || typeof packet.visibility !== "string") {
        target = null; updateHighlight(); return;
      }
      target = packet; updateHighlight();
    });
    ipcMain.on("stage:clicked", event => {
      if (!trusted(event, stage)) return;
      clearHighlight(); publish({ status: "done", text: "연습 버튼을 눌렀습니다. 실제 신청이나 제출은 실행되지 않았습니다." });
    });
    tray = new Tray(trayIcon());
    tray.setToolTip("곁에 · 로컬 UI 시연");
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: "패널 열기", click: showPanel }, { label: "패널 숨기기", click: hidePanel }, { type: "separator" },
      { label: "종료", click: () => app.quit() },
    ]));
    tray.on("click", () => panel.isVisible() ? hidePanel() : showPanel());
    screen.on("display-metrics-changed", () => { clampPanel(); requestMeasurement(); });
    screen.on("display-removed", () => { clampPanel(); requestMeasurement(); });
    await overlay.loadFile(path.join(root, "dist/overlay.html"));
    await panel.loadFile(path.join(root, "dist/index.html"));
    if (!process.argv.includes("--smoke-test")) {
      connection = require("./assistant.cjs").assistant({panel,overlay,publish,clearDemo:clearHighlight,ownFocused:()=>panel.isFocused()||!!stage?.isFocused()});
      publish(connection.state());
    } else showPanel();
    if (process.argv.includes("--smoke-test")) {
      let exitCode = 0;
      try {
        await require("./smoke.cjs")({ panel, overlay, guide, collapse, showPanel, hidePanel,
          getStage: () => stage, getState: () => state, blocked: () => blockedRequests });
      } catch (error) { console.error(error); exitCode = 1; }
      finally { quitting = true; clearHighlight(); app.exit(exitCode); }
    }
  }).catch(error => { console.error("Desktop 시작 실패:", error.message); app.exit(1); });
}
