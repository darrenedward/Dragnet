"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { authClient } from "../../lib/auth-client";
import { BrandLogo } from "../../components/BrandLogo";

export default function RegisterPage() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError("");
    const { error: err } = await authClient.signUp.email({
      name,
      email,
      password,
    });
    if (err) {
      setError(err.message || err.statusText || "Registration failed");
      setLoading(false);
      return;
    }
    router.push("/");
  };

  return (
    <div className="min-h-screen bg-[#0A0D14] flex flex-col items-center justify-center p-4">
      <div className="w-full max-w-sm space-y-6">
        <div className="flex flex-col items-center space-y-1">
          <div className="w-52 max-w-full">
            <BrandLogo priority />
          </div>
          <p className="text-xs text-slate-500 font-mono">Create your account</p>
        </div>

        <form onSubmit={handleRegister} className="space-y-4">
          <div className="space-y-1.5">
            <label className="text-[10px] uppercase tracking-[0.2em] text-slate-500 font-mono font-bold">Name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Your name"
              className="w-full bg-slate-900 border border-white/10 rounded-lg px-3 py-2 text-xs font-mono text-slate-300 placeholder:text-slate-600 focus:outline-none focus:border-cyan-500/40"
              required
            />
          </div>

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
            {loading ? "Creating account..." : "Create Account"}
          </button>
        </form>

        <p className="text-center text-[10px] text-slate-600 font-mono">
          Already have an account?{" "}
          <a href="/login" className="text-cyan-400 hover:text-cyan-300">Sign in</a>
        </p>
      </div>
    </div>
  );
}
