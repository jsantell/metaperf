# Addin new tests to metaperf

* Add test info in `metaperf.html`:
  * `defaultConfig.subtests[TEST_NAME] = true`
  * `testsInfo[TEST_NAME] = TEST_DESCRIPTION`

* Create a new file with test as `test-${TEST_NAME}.js`, wrapped in a function named `test_${TEST_NAME}`.
  * The test wrapper must return a promise that gets resolved upon completion. This function gets
  passed in a `timer` object with `start` and `stop` methods. Call those before and after the function
  you want to measure. Make sure to cleanup properly when you're done.
* Include the file `test-${TEST_NAME}` via script tag in `metaperf.overlay.xul`.
