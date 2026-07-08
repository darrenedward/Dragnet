"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { authClient } from "../../../lib/auth-client";
import { CheckCircle2, KeyRound, Loader2, XCircle } from "lucide-react";

type Status = "loading" | "accepting" | "accepted" | "needs-account" | "needs-login" | "error";

function InviteFlow({ code }: { code: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const callbackURL = searchParams.get("callbackURL") || "/";
  const [status, setStatus] = useState<Status>("loading");
  const [error, setError] = useState<string | null>(null);
  const accepted = useRef(false);

  useEffect(() => {
    let cancelled = false;
    const accept = async () => {
      if (accepted.current) return;
      accepted.current = true;
      try {
        const session = await authClient.getSession({ fetchOptions: { throw: false } });
        if (cancelled) return;
        if (!session.data?.user) {
          setStatus("needs-login");
          return;
        }
        setStatus("accepting");
        const { error: err } = await authClient.organization.acceptInvitation({ invitationId: code });
        if (cancelled) return;
        if (err) {
          setError(err.message || err.statusText || "Failed to accept invitation.");
          setStatus("error");
          return;
        }
        setStatus("accepted");
        try {
          window.localStorage.setItem("dragnet:just-accepted-invite", "1");
        } catch {
          /* storage blocked — banner won't appear but acceptance still succeeded */
        }
        // Create UserRepo records for the accepted invitation
        try {
          await fetch(`/api/team/invite/${code}/accept`, { method: "POST" });
        } catch {
          /* non-critical — records may already exist or can be retried */
        }
        setTimeout(() => router.push(callbackURL), 1200);
      } catch (e: any) {
        if (cancelled) return;
        setError(e?.message || "Unexpected error.");
        setStatus("error");
      }
    };
    accept();
    return () => {
      cancelled = true;
    };
  }, [code, router, callbackURL]);

  if (status === "loading") {
    return (
      <Shell>
        <Loader2 size={32} className="animate-spin text-cyan-400" />
        <p className="text-xs text-slate-500 font-mono">Checking session…</p>
      </Shell>
    );
  }

  if (status === "needs-login") {
    const loginURL = `/login?callbackURL=${encodeURIComponent(`/invite/${code}`)}`;
    const registerURL = `/register?callbackURL=${encodeURIComponent(`/invite/${code}`)}`;
    return (
      <Shell>
        <h1 className="text-lg font-bold text-white font-mono uppercase tracking-wider">Accept invitation</h1>
        <p className="text-xs text-slate-400 font-mono">Sign in or create an account to join the workspace.</p>
        <div className="flex flex-col gap-2 w-full max-w-xs">
          <button
            onClick={() => router.push(loginURL)}
            className="bg-cyan-500 hover:bg-cyan-600 text-black font-semibold text-xs px-4 py-2.5 rounded-lg font-mono"
          >
            Sign in
          </button>
          <button
            onClick={() => router.push(registerURL)}
            className="bg-slate-900 hover:bg-slate-800 text-slate-200 font-semibold text-xs px-4 py-2.5 rounded-lg font-mono border border-white/10"
          >
            Create account
          </button>
        </div>
      </Shell>
    );
  }

  if (status === "accepting") {
    return (
      <Shell>
        <Loader2 size={32} className="animate-spin text-cyan-400" />
        <p className="text-xs text-slate-500 font-mono">Joining workspace…</p>
      </Shell>
    );
  }

  if (status === "accepted") {
    return (
      <Shell>
        <CheckCircle2 size={32} className="text-emerald-400" />
        <h1 className="text-lg font-bold text-white font-mono uppercase tracking-wider">Joined!</h1>
        <p className="text-xs text-slate-400 font-mono">Redirecting to your dashboard…</p>
        <p className="text-[10px] text-slate-500 font-mono flex items-center gap-1.5">
          <KeyRound size={11} className="text-amber-400" />
          You'll be prompted to generate your first API key.
        </p>
      </Shell>
    );
  }

  return (
    <Shell>
      <XCircle size={32} className="text-rose-400" />
      <h1 className="text-lg font-bold text-white font-mono uppercase tracking-wider">Could not accept</h1>
      <p className="text-xs text-slate-400 font-mono">{error}</p>
      <button
        onClick={() => router.push("/")}
        className="bg-slate-900 hover:bg-slate-800 text-slate-200 font-semibold text-xs px-4 py-2.5 rounded-lg font-mono border border-white/10"
      >
        Back to dashboard
      </button>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-[#0A0D14] flex flex-col items-center justify-center p-4 text-center space-y-3">
      {children}
    </div>
  );
}

export default function InvitePage({ params }: { params: Promise<{ code: string }> }) {
  return (
    <Suspense fallback={null}>
      <ResolvedCode params={params} />
    </Suspense>
  );
}

async function ResolvedCode({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  return <InviteFlow code={code} />;
}