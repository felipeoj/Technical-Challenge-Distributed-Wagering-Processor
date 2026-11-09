import { type CallHandler, type ExecutionContext, Injectable, type NestInterceptor } from "@nestjs/common";
import { context, SpanStatusCode, trace } from "@opentelemetry/api";
import { Observable } from "rxjs";

interface RequestLike {
  method: string;
  path: string;
  route?: { path?: string };
}

interface ResponseLike {
  statusCode: number;
  once(event: "finish" | "close", listener: () => void): void;
}

const UNTRACED_ROUTES = ["/health", "/metrics"];
const tracer = trace.getTracer("http");

@Injectable()
export class TracingInterceptor implements NestInterceptor {
  intercept(execution: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = execution.switchToHttp();
    const request = http.getRequest<RequestLike>();
    const response = http.getResponse<ResponseLike>();
    const route = request.route?.path ?? request.path;
    if (UNTRACED_ROUTES.some((prefix) => route.startsWith(prefix))) {
      return next.handle();
    }

    const span = tracer.startSpan(`${request.method} ${route}`, {
      attributes: { "http.request.method": request.method, "http.route": route },
    });
    let ended = false;
    const end = () => {
      if (ended) {
        return;
      }
      ended = true;
      span.setAttribute("http.response.status_code", response.statusCode);
      if (response.statusCode >= 500) {
        span.setStatus({ code: SpanStatusCode.ERROR });
      }
      span.end();
    };
    response.once("finish", end);
    response.once("close", end);

    const active = trace.setSpan(context.active(), span);
    return new Observable((subscriber) => context.with(active, () => next.handle().subscribe(subscriber)));
  }
}
