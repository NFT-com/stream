import tracer from 'dd-trace'
if (['development','staging','production'].includes(process.env.NODE_ENV)) {
  tracer.init({
    profiling: true,
    env: process.env.NODE_ENV,
    service: 'stream',
    logInjection: true,
  })
  tracer.use('http', {
    blocklist: [
      '/health',
      '/favicon.ico',
    ],
  })
}
export default tracer