const global = this;

const OCTANE_URL = "chrome://metaperf/content/pages/octane/index.html";

function MetaPerf() {
}

MetaPerf.prototype = {
  _startTest: function() {
    var self = this;
    var next = this._nextCommand.bind(this);
    var config = this._config;
    var rest = config.rest; // How long to wait in between opening the tab and starting the test.

    let assembledTests = config.subtests.reduce((assembled, testName) => {
      let test = () => {
        console.log(global, testName);
        global[`test_${testName}`](this._createTimer(testName)).then(next);
      };
      for (var r = 0; r < config.repeat; r++) {
        assembled.push(test);
      }
      return assembled;
    }, []);

    this._doSequence(assembledTests, this._doneInternal);
  },

  // Everything below here are common pieces needed for the test runner to function,
  // just copy and pasted from Tart with /s/DAMP/metaperf

  _win: undefined,
  _metaperfTab: undefined,
  _results: [],
  _config: {subtests: [], repeat: 1, rest: 100},
  _nextCommandIx: 0,
  _commands: [],
  _onSequenceComplete: 0,
  _nextCommand: function() {
    if (this._nextCommandIx >= this._commands.length) {
      this._onSequenceComplete();
      return;
    }
    this._commands[this._nextCommandIx++]();
  },
  // Each command at the array a function which must call nextCommand once it's done
  _doSequence: function(commands, onComplete) {
    this._commands = commands;
    this._onSequenceComplete = onComplete;
    this._results = [];
    this._nextCommandIx = 0;

    this._nextCommand();
  },

  _log: function(str) {
    if (window.MozillaFileLogger && window.MozillaFileLogger.log)
      window.MozillaFileLogger.log(str);

    window.dump(str);
  },

  _logLine: function(str) {
    return this._log(str + "\n");
  },

  _reportAllResults: function() {
    var testNames = [];
    var testResults = [];

    var out = "";
    for (var i in this._results) {
      res = this._results[i];
      var disp = [].concat(res.value).map(function(a){return (isNaN(a) ? -1 : a.toFixed(1));}).join(" ");
      out += res.name + ": " + disp + "\n";

      if (!Array.isArray(res.value)) { // Waw intervals array is not reported to talos
        testNames.push(res.name);
        testResults.push(res.value);
      }
    }
    this._log("\n" + out);

    if (content && content.tpRecordTime) {
      content.tpRecordTime(testResults.join(','), 0, testNames.join(','));
    } else {
      //alert(out);
    }
  },

  _onTestComplete: null,

  _createTimer: function (label) {
    return new Timer(this, label);
  },

  _doneInternal: function() {
    this._logLine("METAPERF_RESULTS_JSON=" + JSON.stringify(this._results));
    this._reportAllResults();
    this._win.gBrowser.selectedTab = this._metaperfTab;

    if (this._onTestComplete) {
      this._onTestComplete(JSON.parse(JSON.stringify(this._results))); // Clone results
    }
  },

  startTest: function(doneCallback, config) {
    this._onTestComplete = function (results) {
      Profiler.mark("METAPERF - end", true);
      doneCallback(results);
    };
    this._config = config;

    const Ci = Components.interfaces;
    var wm = Components.classes["@mozilla.org/appshell/window-mediator;1"].getService(Ci.nsIWindowMediator);
    this._win = wm.getMostRecentWindow("navigator:browser");
    this._metaperfTab = this._win.gBrowser.selectedTab;
    this._win.gBrowser.selectedBrowser.focus(); // Unfocus the URL bar to avoid caret blink

    Profiler.mark("METAPERF - start", true);

    return this._startTest();
  }
}

/**
 * Utility timer function; an instance passed into each metaperf's test's `test_${TEST_NAME}` function.
 */
function Timer (metaperf, label) {
  let startTime;
  this.start = () => startTime = performance.now(),
  this.stop = () => {
    metaperf._results.push({ name: `metaperf-${label}`, value: performance.now() - startTime });
  }
}
