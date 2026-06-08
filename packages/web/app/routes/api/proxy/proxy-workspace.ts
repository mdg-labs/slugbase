import { proxyRequest } from "../utils/proxy.js";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";

/** Proxy routes under /workspace/* to the NestJS backend. */
export async function loader({ request }: LoaderFunctionArgs): Promise<Response> {
  return proxyRequest(request);
}

export async function action({ request }: ActionFunctionArgs): Promise<Response> {
  return proxyRequest(request);
}