/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */
"use strict";

const { classes: Cc, interfaces: Ci, utils: Cu, results: Cr } = Components;

let { Services } = Cu.import("resource://gre/modules/Services.jsm", {});
let { Preferences } = Cu.import("resource://gre/modules/Preferences.jsm", {});
let { Task } = Cu.import("resource://gre/modules/Task.jsm", {});
let { Promise } = Cu.import("resource://gre/modules/Promise.jsm", {});
let { devtools } = Cu.import("resource://gre/modules/devtools/Loader.jsm", {});
let { gDevTools } = Cu.import("resource:///modules/devtools/gDevTools.jsm", {});
let { DevToolsUtils } = Cu.import("resource://gre/modules/devtools/DevToolsUtils.jsm", {});
let { DebuggerServer } = Cu.import("resource://gre/modules/devtools/dbg-server.jsm", {});
let { merge } = devtools.require("sdk/util/object");
let { getPerformanceActorsConnection, PerformanceFront } = devtools.require("devtools/performance/front");
let { generateUUID } = Cc['@mozilla.org/uuid-generator;1'].getService(Ci.nsIUUIDGenerator);
let nsIProfilerModule = Cc["@mozilla.org/tools/profiler;1"].getService(Ci.nsIProfiler);

let TargetFactory = devtools.TargetFactory;
let mm = null;

const FRAME_SCRIPT_UTILS_URL = "chrome://metaperf/content/frame-script-utils.js";

const MEMORY_SAMPLE_PROB_PREF = "devtools.performance.memory.sample-probability";
const MEMORY_MAX_LOG_LEN_PREF = "devtools.performance.memory.max-log-length";
const PROFILER_BUFFER_SIZE_PREF = "devtools.performance.profiler.buffer-size";
const PROFILER_SAMPLE_RATE_PREF = "devtools.performance.profiler.sample-frequency-khz";

const FRAMERATE_PREF = "devtools.performance.ui.enable-framerate";
const MEMORY_PREF = "devtools.performance.ui.enable-memory";

const PLATFORM_DATA_PREF = "devtools.performance.ui.show-platform-data";
const IDLE_PREF = "devtools.performance.ui.show-idle-blocks";
const INVERT_PREF = "devtools.performance.ui.invert-call-tree";
const INVERT_FLAME_PREF = "devtools.performance.ui.invert-flame-graph";
const FLATTEN_PREF = "devtools.performance.ui.flatten-tree-recursion";
const JIT_PREF = "devtools.performance.ui.show-jit-optimizations";

let DEFAULT_PREFS = [
  "devtools.debugger.log",
  "devtools.performance.ui.invert-call-tree",
  "devtools.performance.ui.flatten-tree-recursion",
  "devtools.performance.ui.show-platform-data",
  "devtools.performance.ui.show-idle-blocks",
  "devtools.performance.ui.enable-memory",
  "devtools.performance.ui.enable-framerate",
  "devtools.performance.ui.show-jit-optimizations",
  "devtools.performance.memory.sample-probability",
  "devtools.performance.memory.max-log-length",
  "devtools.performance.profiler.buffer-size",
  "devtools.performance.profiler.sample-frequency-khz",
].reduce((prefs, pref) => {
  prefs[pref] = Preferences.get(pref);
  return prefs;
}, {});

// Enable the new performance panel for all tests.
Services.prefs.setBoolPref("devtools.performance.enabled", true);
// Enable logging for all the tests. Both the debugger server and frontend will
// be affected by this pref.
Services.prefs.setBoolPref("devtools.debugger.log", false);

// Disable retro mode.
// TODO bug 1160313
// wrap in a try/catch so when this gets removed, we don't crash here
try {
  Services.prefs.setBoolPref("devtools.performance.ui.retro-mode", false);
} catch (e) {}

/**
 * Call manually in tests that use frame script utils after initializing
 * the tool. Must be called after initializing so we can detect
 * whether or not `content` is a CPOW or not. Call after init but before navigating
 * to different pages.
 */
function loadFrameScripts () {
  mm = gBrowser.selectedBrowser.messageManager;
  mm.loadFrameScript(FRAME_SCRIPT_UTILS_URL, false);
}

function addTab(aUrl, aWindow) {

  let deferred = Promise.defer();
  let targetWindow = aWindow || window;
  let targetBrowser = targetWindow.gBrowser;

  targetWindow.focus();
  let tab = targetBrowser.selectedTab = targetBrowser.addTab(aUrl);
  let linkedBrowser = tab.linkedBrowser;

  linkedBrowser.addEventListener("load", function onLoad() {
    linkedBrowser.removeEventListener("load", onLoad, true);
    deferred.resolve(tab);
  }, true);

  return deferred.promise;
}

function removeTab(aTab, aWindow) {

  let deferred = Promise.defer();
  let targetWindow = aWindow || window;
  let targetBrowser = targetWindow.gBrowser;
  let tabContainer = targetBrowser.tabContainer;

  tabContainer.addEventListener("TabClose", function onClose(aEvent) {
    tabContainer.removeEventListener("TabClose", onClose, false);
    deferred.resolve();
  }, false);

  targetBrowser.removeTab(aTab);
  return deferred.promise;
}

function handleError(aError) {
  finish();
}

function once(aTarget, aEventName, aUseCapture = false, spread = false) {

  let deferred = Promise.defer();

  for (let [add, remove] of [
    ["on", "off"], // Use event emitter before DOM events for consistency
    ["addEventListener", "removeEventListener"],
    ["addListener", "removeListener"]
  ]) {
    if ((add in aTarget) && (remove in aTarget)) {
      aTarget[add](aEventName, function onEvent(...aArgs) {
        aTarget[remove](aEventName, onEvent, aUseCapture);
        deferred.resolve(spread ? aArgs : aArgs[0]);
      }, aUseCapture);
      break;
    }
  }

  return deferred.promise;
}

/**
 * Like `once`, except returns an array so we can
 * access all arguments fired by the event.
 */
function onceSpread(aTarget, aEventName, aUseCapture) {
  return once(aTarget, aEventName, aUseCapture, true);
}

function test () {
  Task.spawn(spawnTest).then(finish, handleError);
}

function initBackend(aUrl, targetOps={}) {
  if (!DebuggerServer.initialized) {
    DebuggerServer.init();
    DebuggerServer.addBrowserActors();
  }

  return Task.spawn(function*() {
    let tab = yield addTab(aUrl);
    let target = TargetFactory.forTab(tab);

    yield target.makeRemote();

    // Attach addition options to `target`. This is used to force mock fronts
    // to smokescreen test different servers where memory or timeline actors
    // may not exist. Possible options that will actually work:
    // TEST_MOCK_MEMORY_ACTOR = true
    // TEST_MOCK_TIMELINE_ACTOR = true
    // TEST_MOCK_BUFFER_CHECK_TIMER = number
    merge(target, targetOps);

    let connection = getPerformanceActorsConnection(target);
    yield connection.open();

    let front = new PerformanceFront(connection);
    return { target, front, connection };
  });
}

function initPerformance(aUrl, selectedTool="performance", targetOps={}) {

  return Task.spawn(function*() {
    let tab = yield addTab(aUrl);
    let target = TargetFactory.forTab(tab);

    yield target.makeRemote();

    // Attach addition options to `target`. This is used to force mock fronts
    // to smokescreen test different servers where memory or timeline actors
    // may not exist. Possible options that will actually work:
    // TEST_MOCK_MEMORY_ACTOR = true
    // TEST_MOCK_TIMELINE_ACTOR = true
    merge(target, targetOps);

    let toolbox = yield gDevTools.showToolbox(target, selectedTool);
    let panel = toolbox.getCurrentPanel();
    return { target, panel, toolbox };
  });
}

/**
 * Initializes a webconsole panel. Returns a target, panel and toolbox reference.
 * Also returns a console property that allows calls to `profile` and `profileEnd`.
 */
function initConsole(aUrl) {
  return Task.spawn(function*() {
    let { target, toolbox, panel } = yield initPerformance(aUrl, "webconsole");
    let { hud } = panel;
    return {
      target, toolbox, panel, console: {
        profile: (s) => consoleExecute(hud, "profile", s),
        profileEnd: (s) => consoleExecute(hud, "profileEnd", s)
      }
    };
  });
}

function consoleExecute (console, method, val) {
  let { ui, jsterm } = console;
  let { promise, resolve } = Promise.defer();
  let message = `console.${method}("${val}")`;

  ui.on("new-messages", handler);
  jsterm.execute(message);

  let { console: c } = Cu.import("resource://gre/modules/devtools/Console.jsm", {});
  function handler (event, messages) {
    for (let msg of messages) {
      if (msg.response._message === message) {
        ui.off("new-messages", handler);
        resolve();
        return;
      }
    }
  }
  return promise;
}

function waitForProfilerConnection() {
  let { promise, resolve } = Promise.defer();
  Services.obs.addObserver(resolve, "performance-actors-connection-opened", false);
  return promise.then(() =>
    Services.obs.removeObserver(resolve, "performance-actors-connection-opened"));
}

function* teardown(panel) {
  let tab = panel.target.tab;
  yield panel._toolbox.destroy();
  yield removeTab(tab);
}

function idleWait(time) {
  return DevToolsUtils.waitForTime(time);
}

function busyWait(time) {
  let start = Date.now();
  let stack;
  while (Date.now() - start < time) { stack = Components.stack; }
}

function consoleMethod (...args) {
  if (!mm) {
    throw new Error("`loadFrameScripts()` must be called before using frame scripts.");
  }
  // Terrible ugly hack -- this gets stringified when it uses the
  // message manager, so an undefined arg in `console.profileEnd()`
  // turns into a stringified "null", which is terrible. This method is only used
  // for test helpers, so swap out the argument if its undefined with an empty string.
  // Differences between empty string and undefined are tested on the front itself.
  if (args[1] == null) {
    args[1] = "";
  }
  mm.sendAsyncMessage("devtools:test:console", args);
}

function* consoleProfile(win, label) {
  let profileStart = once(win.PerformanceController, win.EVENTS.CONSOLE_RECORDING_STARTED);
  consoleMethod("profile", label);
  yield profileStart;
}

function* consoleProfileEnd(win, label) {
  let ended = once(win.PerformanceController, win.EVENTS.CONSOLE_RECORDING_STOPPED);
  consoleMethod("profileEnd", label);
  yield ended;
}

function command (button) {
  let ev = button.ownerDocument.createEvent("XULCommandEvent");
  ev.initCommandEvent("command", true, true, button.ownerDocument.defaultView, 0, false, false, false, false, null);
  button.dispatchEvent(ev);
}

function click (win, button) {
  EventUtils.sendMouseEvent({ type: "click" }, button, win);
}

function mousedown (win, button) {
  EventUtils.sendMouseEvent({ type: "mousedown" }, button, win);
}

function* startRecording(panel, options = {
  waitForOverview: true,
  waitForStateChanged: true
}) {
  let win = panel.panelWin;
  let clicked = panel.panelWin.PerformanceView.once(win.EVENTS.UI_START_RECORDING);
  let willStart = panel.panelWin.PerformanceController.once(win.EVENTS.RECORDING_WILL_START);
  let hasStarted = panel.panelWin.PerformanceController.once(win.EVENTS.RECORDING_STARTED);
  let button = win.$("#main-record-button");

  click(win, button);
  yield clicked;

  yield willStart;
  let stateChanged = options.waitForStateChanged
    ? once(win.PerformanceView, win.EVENTS.UI_STATE_CHANGED)
    : Promise.resolve();

  yield hasStarted;

  let overviewRendered = options.waitForOverview
    ? once(win.OverviewView, win.EVENTS.OVERVIEW_RENDERED)
    : Promise.resolve();

  yield stateChanged;
  yield overviewRendered;
}

function* stopRecording(panel, options = {
  waitForOverview: true,
  waitForStateChanged: true
}) {
  let win = panel.panelWin;
  let clicked = panel.panelWin.PerformanceView.once(win.EVENTS.UI_STOP_RECORDING);
  let willStop = panel.panelWin.PerformanceController.once(win.EVENTS.RECORDING_WILL_STOP);
  let hasStopped = panel.panelWin.PerformanceController.once(win.EVENTS.RECORDING_STOPPED);
  let button = win.$("#main-record-button");
  let overviewRendered = null;

  click(win, button);
  yield clicked;

  yield willStop;
  let stateChanged = options.waitForStateChanged
    ? once(win.PerformanceView, win.EVENTS.UI_STATE_CHANGED)
    : Promise.resolve();

  yield hasStopped;

  // Wait for the final rendering of the overview, not a low res
  // incremental rendering and less likely to be from another rendering that was selected
  while (!overviewRendered && options.waitForOverview) {
    let [_, res] = yield onceSpread(win.OverviewView, win.EVENTS.OVERVIEW_RENDERED);
    if (res === win.FRAMERATE_GRAPH_HIGH_RES_INTERVAL) {
      overviewRendered = true;
    }
  }

  yield stateChanged;
}

function waitForWidgetsRendered(panel) {
  let {
    EVENTS,
    OverviewView,
    WaterfallView,
    JsCallTreeView,
    JsFlameGraphView,
    MemoryCallTreeView,
    MemoryFlameGraphView,
  } = panel.panelWin;

  return Promise.all([
    once(OverviewView, EVENTS.MARKERS_GRAPH_RENDERED),
    once(OverviewView, EVENTS.MEMORY_GRAPH_RENDERED),
    once(OverviewView, EVENTS.FRAMERATE_GRAPH_RENDERED),
    once(OverviewView, EVENTS.OVERVIEW_RENDERED),
    once(WaterfallView, EVENTS.WATERFALL_RENDERED),
    once(JsCallTreeView, EVENTS.JS_CALL_TREE_RENDERED),
    once(JsFlameGraphView, EVENTS.JS_FLAMEGRAPH_RENDERED),
    once(MemoryCallTreeView, EVENTS.MEMORY_CALL_TREE_RENDERED),
    once(MemoryFlameGraphView, EVENTS.MEMORY_FLAMEGRAPH_RENDERED),
  ]);
}

/**
 * Waits until a predicate returns true.
 *
 * @param function predicate
 *        Invoked once in a while until it returns true.
 * @param number interval [optional]
 *        How often the predicate is invoked, in milliseconds.
 */
function waitUntil(predicate, interval = 10) {
  if (predicate()) {
    return Promise.resolve(true);
  }
  let deferred = Promise.defer();
  setTimeout(function() {
    waitUntil(predicate).then(() => deferred.resolve(true));
  }, interval);
  return deferred.promise;
}

// EventUtils just doesn't work!

function dragStart(graph, x, y = 1) {
  x /= window.devicePixelRatio;
  y /= window.devicePixelRatio;
  graph._onMouseMove({ clientX: x, clientY: y });
  graph._onMouseDown({ clientX: x, clientY: y });
}

function dragStop(graph, x, y = 1) {
  x /= window.devicePixelRatio;
  y /= window.devicePixelRatio;
  graph._onMouseMove({ clientX: x, clientY: y });
  graph._onMouseUp({ clientX: x, clientY: y });
}

function dropSelection(graph) {
  graph.dropSelection();
  graph.emit("selecting");
}

/**
 * Fires a key event, like "VK_UP", "VK_DOWN", etc.
 */
function fireKey (e) {
  EventUtils.synthesizeKey(e, {});
}

function reload (aTarget, aEvent = "navigate") {
  aTarget.activeTab.reload();
  return once(aTarget, aEvent);
}

/**
* Forces cycle collection and GC, used in AudioNode destruction tests.
*/
function forceCC () {
  SpecialPowers.DOMWindowUtils.cycleCollect();
  SpecialPowers.DOMWindowUtils.garbageCollect();
  SpecialPowers.DOMWindowUtils.garbageCollect();
}

/**
 * Cleans up test, destroys connection, closes tab, resets prefs
 * and stops the profiler.
 */
function cleanup (target) {
  return Task.spawn(function*() {
    // Make sure the profiler module is stopped when the test finishes.
    nsIProfilerModule.StopProfiler();

    let connection = getPerformanceActorsConnection(target);
    yield connection.destroy();
    removeTab(target.tab);

    // Rollback any pref changes
    Object.keys(DEFAULT_PREFS).forEach(pref => {
      Preferences.set(pref, DEFAULT_PREFS[pref]);
    });

    Cu.forceGC();
  });
}

/**
 * Takes a string `script` and evaluates it directly in the content
 * in potentially a different process.
 */
function evalInDebuggee (script) {
  let deferred = Promise.defer();

  if (!mm) {
    throw new Error("`loadFrameScripts()` must be called when using MessageManager.");
  }

  let id = generateUUID().toString();
  mm.sendAsyncMessage("devtools:test:eval", { script: script, id: id });
  mm.addMessageListener("devtools:test:eval:response", handler);

  function handler ({ data }) {
    if (id !== data.id) {
      return;
    }

    mm.removeMessageListener("devtools:test:eval:response", handler);
    deferred.resolve(data.value);
  }

  return deferred.promise;
}
