"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { authClient } from "../../lib/auth-client";

/**
 * Validate a user-supplied `callbackURL` and return a safe same-origin path.
 *
 * Defence against open-redirect attacks:
 *   - Reject anything that doesn't start with `/` (catches `http://evil`,
 *     `//evil.com` protocol-relative, `mailto:`, `javascript:`, etc.)
 *   - Reject `//...` which browsers treat as protocol-relative
 *   - Reject backslash variants (`/\evil.com`) which some browsers normalise
 *   - Default to `/` for anything that fails the above checks or is missing
 *
 * Returns a string starting with exactly one `/`.
 */
function safeCallbackURL(value: string | null): string {
  if (!value) return "/";
  if (!value.startsWith("/")) return "/";
  if (value.startsWith("//")) return "/";
  if (value.startsWith("/\\")) return "/";
  return value;
}

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const callbackURL = safeCallbackURL(searchParams.get("callbackURL"));

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError("");
    const { error: err } = await authClient.signIn.email({ email, password });
    if (err) {
      setError(err.message || err.statusText || "Login failed");
      setLoading(false);
      return;
    }
    router.push(callbackURL);
  };

  return (
    <div className="min-h-screen bg-[#0A0D14] flex flex-col items-center justify-center p-4">
      <div className="w-full max-w-sm space-y-6">
        <div className="text-center space-y-1">
          <h1 className="text-lg font-bold text-white font-mono uppercase tracking-wider">Dragnet</h1>
          <p className="text-xs text-slate-500 font-mono">Sign in to continue</p>
        </div>

        <form onSubmit={handleLogin} className="space-y-4">
          <div className="space-y-1.5">
            <label className="text-[10px] uppercase tracking-[0.2em] text-slate-500 font-mono font-bold">Email</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              className="w-full bg-slate-900 border border-white/10 rounded-lg px-3 py-2 text-xs font-mono text-slate-300 placeholder:text-slate-600 focus:outline-none focus:border-cyan-500/40"
              required
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-[10px] uppercase tracking-[0.2em] text-slate-500 font-mono font-bold">Password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              className="w-full bg-slate-900 border border-white/10 rounded-lg px-3 py-2 text-xs font-mono text-slate-300 placeholder:text-slate-600 focus:outline-none focus:border-cyan-500/40"
              required
            />
          </div>

          {error && <p className="text-xs text-rose-400 font-mono">{error}</p>}

          <button
            type="submit"
            disabled={loading}
            className="w-full bg-cyan-500 hover:bg-cyan-600 disabled:opacity-50 text-black font-semibold text-xs px-4 py-2.5 rounded-lg transition-all font-mono"
          >
            {loading ? "Signing in..." : "Sign In"}
          </button>
        </form>

        <p className="text-center text-[10px] text-slate-600 font-mono">
          Don't have an account?{" "}
          <a href="/register" className="text-cyan-400 hover:text-cyan-300">Register</a>
        </p>
      </div>
    </div>
  );
}

/**
 * `useSearchParams` requires a Suspense boundary in Next.js 16 App Router
 * for static rendering. Wrap the form so the page can be statically
 * rendered without forcing the whole route to dynamic.
 */
export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}
