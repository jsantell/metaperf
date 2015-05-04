let test_profilerFetchData = Task.async(function*(timer) {
  let { target, front } = yield initBackend(OCTANE_URL);
  let NUMBER_OF_TESTS = 1;
  loadFrameScripts();

  let recording = yield front.startRecording();
  yield evalInDebuggee("Run()");
  // Check every second to see if the test is done
  while (!(yield evalInDebuggee(`completed === ${NUMBER_OF_TESTS}`))) {
    yield idleWait(1000);
  }

  timer.start();
  yield front.stopRecording(recording);
  timer.stop();

  yield cleanup(target);
});
