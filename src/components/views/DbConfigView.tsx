"use client";

import { useState } from "react";
import { motion } from "motion/react";
import { AlertCircle, Database, Eye, EyeOff, RefreshCw, Sparkles, Terminal } from "lucide-react";
import type { DbConfig } from "../../lib/types";

type DbStatus = "configured" | "unconfigured" | "unknown";

interface DbResult {
  success: boolean;
  message: string;
}

interface Props {
  dbConfig: DbConfig;
  setDbConfig: React.Dispatch<React.SetStateAction<DbConfig>>;
  dbStatus: DbStatus;
  reposCount: number;
  prsCount: number;
  isTestingDb: boolean;
  isSavingDb: boolean;
  dbTestResult: DbResult | null;
  dbSaveResult: DbResult | null;
  onTest: () => void;
  onSave: () => void;
}

const DIALECT_CHOICES = [
  { id: "postgresql", label: "PostgreSQL", desc: "Enterprise relational." },
  { id: "supabase", label: "Supabase", desc: "PostgreSQL Cloud DB with Connection Pool." },
];

export default function DbConfigView({
  dbConfig,
  setDbConfig,
  dbStatus,
  reposCount,
  prsCount,
  isTestingDb,
  isSavingDb,
  dbTestResult,
  dbSaveResult,
  onTest,
  onSave,
}: Props) {
  return (
    <motion.div
      key="db-config-frame"
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -10 }}
      transition={{ duration: 0.1 }}
      className="flex flex-col flex-1 overflow-y-auto space-y-5"
    >
      <div className="p-6 bg-[#0F1219] border border-white/10 rounded-xl relative overflow-hidden">
        <div className="absolute top-0 right-0 w-48 h-48 bg-cyan-500/[0.02] rounded-full blur-3xl pointer-events-none" />

        <div className="flex items-center gap-3 mb-4">
          <div className="p-2 bg-cyan-500/10 text-cyan-405 rounded-lg">
            <Database size={20} />
          </div>
          <div>
            <h3 className="text-sm font-bold text-white uppercase tracking-wider font-mono">
              Dynamic Database Integration Pool
            </h3>
            <p className="text-xs text-slate-400">
              Specify connection settings for your preferred backend database. Saved values persist to .env.local and take effect on next server start.
            </p>
          </div>
        </div>

        <DbConfigStats
          dialect={dbConfig.dialect}
          reposCount={reposCount}
          prsCount={prsCount}
          dbStatus={dbStatus}
        />

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2 space-y-4">
            <DialectPicker
              selected={dbConfig.dialect}
              onSelect={(id) => setDbConfig((prev) => ({ ...prev, dialect: id }))}
            />

            {dbConfig.dialect === "supabase" ? (
              <SupabaseField
                value={dbConfig.host}
                onChange={(v) => setDbConfig((prev) => ({ ...prev, host: v }))}
              />
            ) : (
              <PostgresFields dbConfig={dbConfig} setDbConfig={setDbConfig} />
            )}

            <ActionButtons
              isTestingDb={isTestingDb}
              isSavingDb={isSavingDb}
              onTest={onTest}
              onSave={onSave}
            />

            {dbTestResult && (
              <ResultBanner label={dbTestResult.success ? "Verification Succeeded" : "Verification Failed"} result={dbTestResult} tone={dbTestResult.success ? "emerald" : "rose"} />
            )}
            {dbSaveResult && (
              <ResultBanner label={dbSaveResult.success ? "Configuration Applied" : "Application Failed"} result={dbSaveResult} tone={dbSaveResult.success ? "cyan" : "rose"} />
            )}
          </div>

          <ExplanatoryCard />
        </div>
      </div>
    </motion.div>
  );
}

function DbConfigStats({
  dialect,
  reposCount,
  prsCount,
  dbStatus,
}: {
  dialect: string;
  reposCount: number;
  prsCount: number;
  dbStatus: DbStatus;
}) {
  const statusStyles =
    dbStatus === "configured"
      ? "text-emerald-400 bg-emerald-500/10 border-emerald-500/20"
      : dbStatus === "unconfigured"
      ? "text-amber-400 bg-amber-500/10 border-amber-500/20"
      : "text-slate-400 bg-slate-500/10 border-slate-500/20";
  const statusLabel =
    dbStatus === "configured" ? "Configured" : dbStatus === "unconfigured" ? "Not Configured" : "Checking";

  return (
    <div className="grid grid-cols-1 md:grid-cols-4 gap-3 bg-slate-950/65 p-4 rounded-xl border border-white/5 mb-6">
      <StatCell label="Active Dialect" value={dialect} valueClass="text-cyan-400" />
      <StatCell label="Registered Projects" value={String(reposCount)} />
      <StatCell label="Detected PRs" value={String(prsCount)} valueClass="text-indigo-400" />
      <div className="font-mono text-center p-2">
        <div className="text-[10px] text-slate-500 uppercase">Status</div>
        <div className={`text-[10px] font-bold uppercase mt-1 px-1.5 py-0.5 rounded border inline-block ${statusStyles}`}>
          {statusLabel}
        </div>
      </div>
    </div>
  );
}

function StatCell({ label, value, valueClass = "text-white" }: { label: string; value: string; valueClass?: string }) {
  return (
    <div className="font-mono text-center md:border-r md:border-white/5 p-2">
      <div className="text-[10px] text-slate-500 uppercase">{label}</div>
      <div className={`text-xs font-bold uppercase mt-1 ${valueClass}`}>{value}</div>
    </div>
  );
}

function DialectPicker({ selected, onSelect }: { selected: string; onSelect: (id: string) => void }) {
  return (
    <div className="space-y-3">
      <label className="text-[11px] font-mono text-slate-400 uppercase font-bold block">Database Choice</label>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        {DIALECT_CHOICES.map((choice) => (
          <button
            key={choice.id}
            onClick={() => onSelect(choice.id)}
            className={`p-3 rounded-lg text-left transition-all border flex flex-col justify-between ${
              selected === choice.id
                ? "bg-cyan-500/10 border-cyan-400 text-white ring-1 ring-cyan-500/30"
                : "bg-slate-900/50 border-white/5 text-slate-400 hover:bg-white/5"
            }`}
          >
            <span className="text-xs font-bold uppercase font-mono">{choice.label}</span>
            <span className="text-[9px] text-slate-500 mt-1 font-sans">{choice.desc}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function SupabaseField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [showValue, setShowValue] = useState(false);
  return (
    <div className="space-y-2 max-w-md">
      <label className="text-[10px] uppercase font-mono text-slate-400 block">Supabase Connection Pool String</label>
      <div className="relative">
        <input
          type={showValue ? "text" : "password"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="w-full bg-slate-950 border border-white/10 rounded-lg px-3 py-2 pr-10 text-xs text-slate-100 font-mono focus:border-cyan-500 outline-none animate-fadeIn"
          placeholder="postgresql://...pooler.supabase.com:6543/postgres"
        />
        <button
          type="button"
          onClick={() => setShowValue(!showValue)}
          className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-500 hover:text-cyan-400 transition-colors p-1"
          title={showValue ? "Hide connection string" : "Show connection string"}
          aria-label={showValue ? "Hide connection string" : "Show connection string"}
        >
          {showValue ? <EyeOff size={14} /> : <Eye size={14} />}
        </button>
      </div>
      <p className="text-[10px] text-slate-500 italic">
        Enter full pooled connection string from Supabase dashboard (use session/transaction pool port 6543).
      </p>
    </div>
  );
}

function PostgresFields({
  dbConfig,
  setDbConfig,
}: {
  dbConfig: DbConfig;
  setDbConfig: React.Dispatch<React.SetStateAction<DbConfig>>;
}) {
  const [showPassword, setShowPassword] = useState(false);

  const field = (label: string, key: keyof DbConfig, placeholder: string, type = "text") => (
    <div className="space-y-1.5">
      <label className="text-[10px] uppercase font-mono text-slate-400 block">{label}</label>
      <input
        type={type}
        value={dbConfig[key] as string}
        onChange={(e) => setDbConfig((prev) => ({ ...prev, [key]: e.target.value }))}
        className="w-full bg-slate-950 border border-white/10 rounded-lg px-3 py-2 text-xs text-slate-100 font-mono focus:border-cyan-500 outline-none"
        placeholder={placeholder}
      />
    </div>
  );

  const passwordField = () => (
    <div className="space-y-1.5">
      <label className="text-[10px] uppercase font-mono text-slate-400 block">Password</label>
      <div className="relative">
        <input
          type={showPassword ? "text" : "password"}
          value={dbConfig.password}
          onChange={(e) => setDbConfig((prev) => ({ ...prev, password: e.target.value }))}
          className="w-full bg-slate-950 border border-white/10 rounded-lg px-3 py-2 pr-10 text-xs text-slate-100 font-mono focus:border-cyan-500 outline-none"
          placeholder="Enter password to test or save"
        />
        <button
          type="button"
          onClick={() => setShowPassword(!showPassword)}
          className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-500 hover:text-cyan-400 transition-colors p-1"
          title={showPassword ? "Hide password" : "Show password"}
          aria-label={showPassword ? "Hide password" : "Show password"}
        >
          {showPassword ? <EyeOff size={14} /> : <Eye size={14} />}
        </button>
      </div>
    </div>
  );

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 max-w-2xl bg-slate-900/25 p-4 rounded-xl border border-white/5 animate-fadeIn">
      {field("Hostname / Host IP", "host", "e.g. localhost or cloudsql instance ip")}
      {field("Port", "port", dbConfig.dialect === "postgresql" ? "5432" : "6543")}
      {field("Username", "username", "e.g. postgres or root")}
      {passwordField()}
      <div className="space-y-1.5 sm:col-span-2">{field("Database Name", "database", "e.g. greploop")}</div>
    </div>
  );
}

function ActionButtons({
  isTestingDb,
  isSavingDb,
  onTest,
  onSave,
}: {
  isTestingDb: boolean;
  isSavingDb: boolean;
  onTest: () => void;
  onSave: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3 pt-2">
      <button
        onClick={onTest}
        disabled={isTestingDb}
        className="bg-slate-900 hover:bg-slate-800 disabled:opacity-50 text-slate-300 border border-white/10 font-mono text-xs font-bold px-4 py-2 rounded-lg transition-all flex items-center gap-2 cursor-pointer"
      >
        {isTestingDb ? <RefreshCw size={13} className="animate-spin text-cyan-400" /> : <Terminal size={13} className="text-cyan-400" />}
        <span>{isTestingDb ? "Testing Connection..." : "Test Connection"}</span>
      </button>
      <button
        onClick={onSave}
        disabled={isSavingDb}
        className="bg-cyan-500 hover:bg-cyan-600 disabled:opacity-50 active:scale-[0.99] text-black font-semibold text-xs px-4 py-2 rounded-lg transition-all flex items-center gap-2 shadow-[0_4px_12px_rgba(6,182,212,0.15)] cursor-pointer"
      >
        {isSavingDb ? <RefreshCw size={13} className="animate-spin" /> : <Database size={13} />}
        <span>{isSavingDb ? "Saving..." : "Save to .env.local"}</span>
      </button>
      <span className="text-[10px] text-slate-500 italic">
        A dev server restart is required for the new connection to take effect.
      </span>
    </div>
  );
}

function ResultBanner({
  label,
  result,
  tone,
}: {
  label: string;
  result: DbResult;
  tone: "emerald" | "cyan" | "rose";
}) {
  const toneClass =
    tone === "emerald"
      ? "bg-emerald-500/10 border-emerald-500/20 text-emerald-400"
      : tone === "cyan"
      ? "bg-cyan-500/10 border-cyan-500/20 text-cyan-400"
      : "bg-rose-500/10 border-rose-500/20 text-rose-400";
  return (
    <div className={`p-4 rounded-lg text-xs font-mono border animate-fadeIn ${toneClass}`}>
      <div className="font-bold uppercase mb-1">{label}</div>
      <div>{result.message}</div>
    </div>
  );
}

function ExplanatoryCard() {
  return (
    <div className="space-y-4">
      <div className="p-4 bg-slate-900/40 rounded-xl border border-white/5 space-y-4">
        <h4 className="text-xs font-bold font-mono text-slate-300 uppercase flex items-center gap-1.5">
          <Sparkles size={13} className="text-cyan-400" />
          <span>Why Multi-Database?</span>
        </h4>
        <p className="text-[11px] leading-relaxed text-slate-400">
          GrepLoop supports two Postgres deployment shapes for the same data model:
        </p>
        <ul className="space-y-2 text-[10px] text-slate-500 pl-3 list-disc">
          <li>
            <strong className="text-slate-300">Local Postgres:</strong> for development without external dependencies.
          </li>
          <li>
            <strong className="text-slate-300">Supabase pooler:</strong> for self-hosted SaaS deployments using port 6543 with pgbouncer.
          </li>
        </ul>
      </div>
      <div className="p-4 rounded-xl border border-amber-500/10 bg-amber-500/[0.02] text-[11px] text-amber-500/85">
        <h5 className="font-bold font-mono uppercase mb-1 flex items-center gap-1">
          <AlertCircle size={12} />
          <span>Restart Required</span>
        </h5>
        <span>
          Connection changes are written to .env.local but the Prisma client only reads it at process start. After saving, restart <code className="font-mono bg-amber-500/10 px-1 rounded">npm run dev</code> for the new pool to take effect.
        </span>
      </div>
    </div>
  );
}
