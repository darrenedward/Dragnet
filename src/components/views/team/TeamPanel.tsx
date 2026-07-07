"use client";

import { useEffect, useState } from "react";
import { motion } from "motion/react";
import { Check, Copy, Mail, Plus, Trash2, Users, X } from "lucide-react";
import { authClient } from "../../../lib/auth-client";
import { toast } from "../../../lib/toast";

interface MemberRow {
  id: string;
  userId: string;
  role: string;
  createdAt: string;
  user: { id: string; name: string | null; email: string };
}

interface InvitationRow {
  id: string;
  email: string;
  role: string;
  status: string;
  expiresAt: string;
}

interface ActiveOrgSummary {
  id: string;
  name: string;
  slug: string;
}

export default function TeamPanel() {
  const [activeOrg, setActiveOrg] = useState<ActiveOrgSummary | null>(null);
  const [members, setMembers] = useState<MemberRow[]>([]);
  const [invitations, setInvitations] = useState<InvitationRow[]>([]);
  const [keyCounts, setKeyCounts] = useState<Record<string, number>>({});
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<"member" | "admin">("member");
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    try {
      const [activeRes, listRes, invRes, keysRes] = await Promise.all([
        authClient.organization.getFullOrganization({}),
        authClient.organization.listMembers({}),
        authClient.organization.listInvitations({}),
        fetch("/api/team/member-stats").then((r) => (r.ok ? r.json() : { counts: {} })),
      ]);
      if (activeRes.data) {
        setActiveOrg({
          id: activeRes.data.id,
          name: activeRes.data.name,
          slug: activeRes.data.slug,
        });
      }
      const listData = listRes.data as { members?: unknown[] } | undefined;
      setMembers(Array.isArray(listData?.members) ? (listData.members as MemberRow[]) : []);
      const invData = invRes.data as unknown[] | undefined;
      setInvitations(
        Array.isArray(invData)
          ? invData.map((i: any) => ({
              id: i.id,
              email: i.email,
              role: i.role,
              status: i.status,
              expiresAt: typeof i.expiresAt === "string" ? i.expiresAt : new Date(i.expiresAt).toISOString(),
            }))
          : [],
      );
      setKeyCounts(keysRes.counts ?? {});
    } catch (e: any) {
      setError(e?.message || "Failed to load team data.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  const handleInvite = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const { error: err } = await authClient.organization.inviteMember({
        email: inviteEmail.trim(),
        role: inviteRole,
      });
      if (err) {
        setError(err.message || err.statusText || "Invitation failed.");
        return;
      }
      setInviteEmail("");
      toast.success(`Invitation sent to ${inviteEmail.trim()}`);
      await refresh();
    } catch (e: any) {
      setError(e?.message || "Invitation failed.");
    } finally {
      setSubmitting(false);
    }
  };

  const handleRemove = async (memberId: string, label: string) => {
    if (!window.confirm(`Remove ${label} from the workspace? They will lose access immediately.`)) return;
    try {
      const { error: err } = await authClient.organization.removeMember({ memberIdOrEmail: memberId });
      if (err) {
        toast.error(err.message || err.statusText || "Remove failed.");
        return;
      }
      toast.success(`${label} removed`);
      await refresh();
    } catch (e: any) {
      toast.error(e?.message || "Remove failed.");
    }
  };

  const handleCancelInvite = async (invitationId: string, email: string) => {
    try {
      const { error: err } = await authClient.organization.cancelInvitation({ invitationId });
      if (err) {
        toast.error(err.message || err.statusText || "Cancel failed.");
        return;
      }
      toast.success(`Invitation to ${email} cancelled`);
      await refresh();
    } catch (e: any) {
      toast.error(e?.message || "Cancel failed.");
    }
  };

  const handleCopyInviteLink = async (inv: InvitationRow) => {
    const url = `${window.location.origin}/invite/${inv.id}`;
    try {
      await navigator.clipboard.writeText(url);
      toast.success("Invite link copied");
    } catch {
      toast.error("Clipboard blocked — copy manually: " + url);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64 text-slate-500 font-mono text-xs">
        Loading team…
      </div>
    );
  }

  return (
    <motion.div
      key="team-frame"
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -10 }}
      transition={{ duration: 0.1 }}
      className="flex flex-col flex-1 min-h-0 space-y-5"
    >
      <div className="flex-1 min-h-0 overflow-y-auto p-6 bg-[#0F1219] border border-white/10 rounded-xl relative space-y-5">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-cyan-500/10 text-cyan-400 rounded-lg">
            <Users size={20} />
          </div>
          <div className="flex-1">
            <h3 className="text-sm font-bold text-white uppercase tracking-wider font-mono">
              Team
            </h3>
            <p className="text-xs text-slate-400">
              {activeOrg ? (
                <>
                  Workspace: <span className="text-slate-200 font-mono">{activeOrg.name}</span>{" "}
                  <span className="text-slate-600">({activeOrg.slug})</span>
                </>
              ) : (
                "No workspace yet — sign in once to auto-create one."
              )}
            </p>
          </div>
        </div>

        {error && (
          <div className="bg-rose-500/10 border border-rose-500/30 rounded-lg px-3 py-2 text-xs text-rose-300 font-mono">
            {error}
          </div>
        )}

        <div className="space-y-2">
          <h4 className="text-[10px] uppercase tracking-[0.2em] text-slate-500 font-mono font-bold">
            Members ({members.length})
          </h4>
          <div className="space-y-1.5">
            {members.length === 0 ? (
              <div className="text-[10px] text-slate-600 font-mono italic">No members yet.</div>
            ) : (
              members.map((m) => (
                <div
                  key={m.id}
                  className="flex items-center justify-between gap-3 bg-slate-900/60 p-3 rounded-lg border border-white/5"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-mono font-bold text-slate-300 truncate">
                        {m.user.name || m.user.email}
                      </span>
                      <span className="text-[9px] uppercase font-mono text-cyan-400 bg-cyan-500/10 px-1.5 py-0.5 rounded border border-cyan-500/20">
                        {m.role}
                      </span>
                    </div>
                    <div className="text-[10px] text-slate-500 font-mono mt-0.5">
                      {m.user.email}
                    </div>
                    <div className="text-[9px] text-slate-600 font-mono mt-0.5">
                      {keyCounts[m.userId] ?? 0} API key{(keyCounts[m.userId] ?? 0) === 1 ? "" : "s"}
                    </div>
                  </div>
                  <button
                    onClick={() => handleRemove(m.id, m.user.name || m.user.email)}
                    disabled={m.role === "owner"}
                    title={m.role === "owner" ? "Owners cannot be removed" : "Remove member"}
                    className="p-2 hover:bg-rose-500/10 rounded-lg text-slate-500 hover:text-rose-400 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              ))
            )}
          </div>
        </div>

        <div className="space-y-2">
          <h4 className="text-[10px] uppercase tracking-[0.2em] text-slate-500 font-mono font-bold">
            Pending invitations ({invitations.length})
          </h4>
          <div className="space-y-1.5">
            {invitations.length === 0 ? (
              <div className="text-[10px] text-slate-600 font-mono italic">
                No outstanding invitations.
              </div>
            ) : (
              invitations.map((inv) => (
                <div
                  key={inv.id}
                  className="flex items-center justify-between gap-3 bg-slate-900/60 p-3 rounded-lg border border-white/5"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <Mail size={11} className="text-slate-500" />
                      <span className="text-xs font-mono font-bold text-slate-300 truncate">
                        {inv.email}
                      </span>
                      <span className="text-[9px] uppercase font-mono text-amber-400 bg-amber-500/10 px-1.5 py-0.5 rounded border border-amber-500/20">
                        {inv.status}
                      </span>
                    </div>
                    <div className="text-[9px] text-slate-600 font-mono mt-0.5">
                      Expires {new Date(inv.expiresAt).toLocaleDateString()}
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => handleCopyInviteLink(inv)}
                      className="p-2 hover:bg-cyan-500/10 rounded-lg text-slate-500 hover:text-cyan-400 transition-colors"
                      title="Copy invite link"
                    >
                      <Copy size={13} />
                    </button>
                    <button
                      onClick={() => handleCancelInvite(inv.id, inv.email)}
                      className="p-2 hover:bg-rose-500/10 rounded-lg text-slate-500 hover:text-rose-400 transition-colors"
                      title="Cancel invitation"
                    >
                      <X size={13} />
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        <form onSubmit={handleInvite} className="space-y-3 pt-4 border-t border-white/5">
          <h4 className="text-[10px] uppercase tracking-[0.2em] text-slate-500 font-mono font-bold">
            Invite a teammate
          </h4>
          <div className="flex flex-col sm:flex-row gap-2">
            <input
              type="email"
              required
              value={inviteEmail}
              onChange={(e) => setInviteEmail(e.target.value)}
              placeholder="teammate@example.com"
              className="flex-1 bg-slate-900 border border-white/10 rounded-lg px-3 py-2 text-xs font-mono text-slate-300 placeholder:text-slate-600 focus:outline-none focus:border-cyan-500/40"
            />
            <select
              value={inviteRole}
              onChange={(e) => setInviteRole(e.target.value as "member" | "admin")}
              className="bg-slate-900 border border-white/10 rounded-lg px-3 py-2 text-xs font-mono text-slate-300 focus:outline-none focus:border-cyan-500/40"
            >
              <option value="member">Member</option>
              <option value="admin">Admin</option>
            </select>
            <button
              type="submit"
              disabled={submitting || !inviteEmail.trim()}
              className="bg-cyan-500 hover:bg-cyan-600 disabled:opacity-50 text-black font-semibold text-xs px-4 py-2 rounded-lg transition-all flex items-center gap-2 shadow-[0_4px_12px_rgba(6,182,212,0.15)] cursor-pointer"
            >
              <Plus size={13} />
              <span>{submitting ? "Sending..." : "Send invite"}</span>
            </button>
          </div>
          <p className="text-[10px] text-slate-500 font-mono">
            Sends a server-issued invitation. Recipients can accept via the link on the invitation or by signing up at this URL and using it.
          </p>
        </form>
      </div>
    </motion.div>
  );
}