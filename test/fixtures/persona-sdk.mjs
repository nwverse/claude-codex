// Drive the companion through its public SDK callbacks in a child process. The
// adapter socket, model profiles, persistent receipts and turns are real.
export class RpcError extends Error {}
export function createRuntime(driver, options) {
  return {
    start() {
      process.on('message', async ({ id, method, params }) => {
        try {
          const result = await driver[method](params)
          process.send({ id, result })
        } catch (error) {
          process.send({ id, error: error.message })
        }
      })
      process.send({ ready: options.modelSwitch && typeof driver.modes === 'function' })
    },
    sessionsChanged() {},
    launchersChanged() {},
  }
}
