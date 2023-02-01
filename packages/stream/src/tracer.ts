import opentelemetry = require('@opentelemetry/api');

import { Attributes, SpanKind } from '@opentelemetry/api'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
import { registerInstrumentations } from '@opentelemetry/instrumentation'
import { ExpressInstrumentation, ExpressLayerType } from '@opentelemetry/instrumentation-express'
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http'
import { IORedisInstrumentation } from '@opentelemetry/instrumentation-ioredis'
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg'
import { Resource } from '@opentelemetry/resources'
import { AlwaysOnSampler, Sampler, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base'
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node'
import { SemanticAttributes, SemanticResourceAttributes } from '@opentelemetry/semantic-conventions'

type FilterFunction = (spanName: string, spanKind: SpanKind, attributes: Attributes) => boolean;

function filterSampler(filterFn: FilterFunction, parent: Sampler): Sampler {
  return {
    shouldSample(ctx, tid, spanName, spanKind, attr, links) {
      if (filterFn(spanName, spanKind, attr)) {
        return { decision: opentelemetry.SamplingDecision.NOT_RECORD }
      }
      return parent.shouldSample(ctx, tid, spanName, spanKind, attr, links)
    },
    toString() {
      return `FilterSampler(${parent.toString()})`
    },
  }
}

function ignoreSpan(_spanName: string, spanKind: SpanKind, attributes: Attributes): boolean {
  return attributes[SemanticAttributes.HTTP_METHOD] === 'OPTIONS'
    || (attributes[SemanticAttributes.HTTP_TARGET]
        && ['/health', '/favicon.ico'].includes(attributes[SemanticAttributes.HTTP_TARGET].toString()))
        || (attributes[SemanticAttributes.HTTP_ROUTE]
          && ['/health', '/'].includes(attributes[SemanticAttributes.HTTP_ROUTE].toString()))
    || (attributes[SemanticAttributes.HTTP_URL]
        && attributes[SemanticAttributes.HTTP_URL].toString().includes('sentry.io'))
}

export const setupTracing = (serviceName: string): opentelemetry.Tracer => {
  const provider = new NodeTracerProvider({
    resource: new Resource({
      [SemanticResourceAttributes.SERVICE_NAME]: serviceName,
    }),
    sampler: filterSampler(ignoreSpan, new AlwaysOnSampler()),
  })
  registerInstrumentations({
    tracerProvider: provider,
    instrumentations: [
      // Express instrumentation expects HTTP layer to be instrumented
      new HttpInstrumentation(),
      new ExpressInstrumentation({
        ignoreLayersType: [ExpressLayerType.MIDDLEWARE],
      }),
      new IORedisInstrumentation({
        requireParentSpan: false,
      }),
      new PgInstrumentation({
        requireParentSpan: true,
      }),
    ],
  })

  const exporter = new OTLPTraceExporter()

  provider.addSpanProcessor(new SimpleSpanProcessor(exporter))

  // Initialize the OpenTelemetry APIs to use the NodeTracerProvider bindings
  provider.register()

  return opentelemetry.trace.getTracer(serviceName)
}