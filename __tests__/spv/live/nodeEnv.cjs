// Jest environment for the live tests. jest-expo replaces global fetch with a
// React Native polyfill that cannot reach localhost, and live tests must hit the
// real stack. The environment constructor runs in the outer (real Node) realm, so
// it can hand the genuine fetch to the test sandbox before any setup file runs.
const { TestEnvironment } = require('jest-environment-node')

class LiveEnvironment extends TestEnvironment {
  constructor(config, context) {
    super(config, context)
    this.global.__nodeFetch = fetch
  }
}

module.exports = LiveEnvironment
