import { ApiError } from "../lib/api";

/** Explains a failed API call; in development the usual causes are a stopped API or a missing token. */
export function ApiErrorPanel({ error }: { error: unknown }) {
  const apiError = error instanceof ApiError ? error : undefined;
  return (
    <div className="panel panel-error" role="alert">
      <h2>Could not load data</h2>
      <p>
        {apiError ? (
          <>
            <code>{apiError.code}</code> {apiError.message}
          </>
        ) : (
          "Unexpected error while calling the API."
        )}
      </p>
      {apiError?.code === "API_UNREACHABLE" && (
        <p className="muted">
          Start the registry with <code>pnpm --filter @contractpulse/api dev</code> or set{" "}
          <code>CONTRACTPULSE_API_URL</code>.
        </p>
      )}
      {apiError?.status === 401 && (
        <p className="muted">
          Set <code>CONTRACTPULSE_API_TOKEN</code> to a token of the <code>CONTRACTPULSE_WORKSPACE</code> workspace
          (the seed prints one, or uses <code>CONTRACTPULSE_DEMO_TOKEN</code>).
        </p>
      )}
    </div>
  );
}
