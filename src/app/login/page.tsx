"use client";

import { Suspense, useState, type FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowRight, Eye, EyeOff, ShieldCheck } from "lucide-react";
import { authClient } from "../../lib/auth-client";
import { BrandLogo } from "../../components/BrandLogo";

function safeCallbackURL(value: string | null): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) return "/";
  return value;
}

function BrandMark() {
  return (
    <div className="w-52 max-w-full" aria-label="Dragnet logo">
      <BrandLogo priority />
    </div>
  );
}

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const callbackURL = safeCallbackURL(searchParams.get("callbackURL"));
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleLogin = async (event: FormEvent) => {
    event.preventDefault();
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
    <main className="relative flex min-h-dvh items-center justify-center overflow-hidden bg-[#070b12] px-4 py-8 text-slate-300 sm:px-6">
      <div className="pointer-events-none absolute inset-0 opacity-40 [background-image:linear-gradient(rgba(34,211,238,0.04)_1px,transparent_1px),linear-gradient(90deg,rgba(34,211,238,0.04)_1px,transparent_1px)] [background-size:48px_48px]" />
      <div className="pointer-events-none absolute left-1/2 top-[-20%] h-[520px] w-[520px] -translate-x-1/2 rounded-full bg-cyan-500/10 blur-[120px]" />

      <div className="relative grid w-full max-w-5xl overflow-hidden rounded-2xl border border-white/10 bg-[#0b111b]/90 shadow-2xl shadow-black/40 backdrop-blur lg:grid-cols-[1.08fr_0.92fr]">
        <section className="hidden border-r border-white/10 bg-[#091321] p-8 lg:flex lg:flex-col lg:justify-between xl:p-12" aria-labelledby="brand-heading">
          <div>
            <BrandMark />
            <p className="mt-8 font-mono text-[10px] font-bold uppercase tracking-[0.28em] text-cyan-400">Automated PR agent</p>
            <h1 id="brand-heading" className="mt-4 max-w-md text-4xl font-semibold tracking-tight text-white xl:text-5xl">Review every change with confidence.</h1>
            <p className="mt-5 max-w-md text-sm leading-7 text-slate-400">Dragnet keeps code review close to your repositories, your infrastructure, and your choice of AI providers.</p>
          </div>
          <div className="mt-10 overflow-hidden rounded-xl border border-cyan-400/15 bg-[#070d17] shadow-[0_0_50px_rgba(8,145,178,0.08)]">
            <BrandLogo className="opacity-90" />
          </div>
        </section>

        <section className="flex items-center justify-center p-6 sm:p-10 lg:p-12" aria-labelledby="login-heading">
          <div className="w-full max-w-sm">
            <div className="mb-8 lg:hidden">
              <BrandMark />
            </div>
            <div className="mb-8">
              <p className="font-mono text-[10px] font-bold uppercase tracking-[0.25em] text-cyan-400">Welcome back</p>
              <h2 id="login-heading" className="mt-2 text-2xl font-semibold tracking-tight text-white">Sign in to Dragnet</h2>
              <p className="mt-2 text-sm leading-6 text-slate-400">Continue to your review workspace.</p>
            </div>

            <form onSubmit={handleLogin} className="space-y-5">
              <div className="space-y-2">
                <label htmlFor="email" className="block font-mono text-[10px] font-bold uppercase tracking-[0.2em] text-slate-400">Email</label>
                <input id="email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@example.com" autoComplete="email" className="h-12 w-full rounded-lg border border-white/10 bg-[#070c14] px-4 text-sm text-white outline-none transition-colors placeholder:text-slate-600 focus:border-cyan-400/70 focus:ring-2 focus:ring-cyan-400/15" required />
              </div>

              <div className="space-y-2">
                <label htmlFor="password" className="block font-mono text-[10px] font-bold uppercase tracking-[0.2em] text-slate-400">Password</label>
                <div className="relative">
                  <input id="password" type={showPassword ? "text" : "password"} value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Enter your password" autoComplete="current-password" className="h-12 w-full rounded-lg border border-white/10 bg-[#070c14] px-4 pr-12 text-sm text-white outline-none transition-colors placeholder:text-slate-600 focus:border-cyan-400/70 focus:ring-2 focus:ring-cyan-400/15" required />
                  <button type="button" onClick={() => setShowPassword((visible) => !visible)} className="absolute right-1 top-1 flex h-10 w-10 items-center justify-center rounded-md text-slate-500 transition-colors hover:bg-white/5 hover:text-cyan-300 focus:outline-none focus:ring-2 focus:ring-cyan-400/50" aria-label={showPassword ? "Hide password" : "Show password"}>
                    {showPassword ? <EyeOff size={17} /> : <Eye size={17} />}
                  </button>
                </div>
              </div>

              {error && <p role="alert" aria-live="polite" className="rounded-lg border border-rose-400/20 bg-rose-400/10 px-3 py-2.5 text-sm leading-5 text-rose-300">{error}</p>}

              <button type="submit" disabled={loading} className="flex h-12 w-full items-center justify-center gap-2 rounded-lg bg-cyan-400 px-4 text-sm font-bold text-[#061017] shadow-[0_0_24px_rgba(34,211,238,0.16)] transition-all hover:bg-cyan-300 focus:outline-none focus:ring-2 focus:ring-cyan-300/70 disabled:cursor-not-allowed disabled:opacity-50">
                {loading ? "Signing in…" : "Sign in"}
                {!loading && <ArrowRight size={17} />}
              </button>
            </form>

            <div className="mt-8 flex items-center justify-center gap-2 text-xs text-slate-500">
              <ShieldCheck size={14} className="text-emerald-400" />
              <span>Secure workspace access</span>
            </div>
            <p className="mt-6 text-center text-sm text-slate-500">Don&apos;t have an account? <a href="/register" className="font-medium text-cyan-300 underline decoration-cyan-300/30 underline-offset-4 transition-colors hover:text-cyan-200">Create one</a></p>
          </div>
        </section>
      </div>
    </main>
  );
}

export default function LoginPage() {
  return <Suspense fallback={null}><LoginForm /></Suspense>;
}
