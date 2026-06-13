import { data, type LoaderFunctionArgs } from "react-router";

export function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  // React Router uses thrown `data()` responses for HTTP error statuses.
  // eslint-disable-next-line @typescript-eslint/only-throw-error -- RR7 response throw
  throw data(null, {
    status: 404,
    statusText: `Not found: ${url.pathname}`,
  });
}

export default function NotFoundRoute() {
  return null;
}
