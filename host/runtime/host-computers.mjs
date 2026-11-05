/** Report the original bridge's registered/live machines to its parent process. */
export function observeHostComputers(bridge, { send, intervalMs = 5000 } = {}) {
  if (!send && !process.send) return { bridge, close() {} };
  send ??= value => {
    if (process.connected) process.send(value, () => {});
  };
  const publish = () => {
    try {
      const computers = bridge.userComputers.list().map(({ id, label, connected }) => ({
        id, label, connected: connected === true,
        platform: id.startsWith('mac-') ? 'darwin' : 'unknown',
        capabilities: ['exec', 'files'],
      }));
      send({ type: 'local-computers', available: true, computers });
    } catch {
      send({ type: 'local-computers', available: false, computers: [] });
    }
  };
  const timer = setInterval(publish, intervalMs);
  timer.unref();
  publish();
  return {
    bridge: {
      ...bridge,
      registerProvider(sendFrame) {
        const unregister = bridge.registerProvider(sendFrame);
        publish();
        return () => { unregister(); publish(); };
      },
      submitResponses(batch) {
        const result = bridge.submitResponses(batch);
        publish();
        return result;
      },
    },
    close() {
      clearInterval(timer);
      send({ type: 'local-computers', available: false, computers: [] });
    },
  };
}
