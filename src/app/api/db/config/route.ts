import { NextResponse } from "next/server";
import {
  buildConnectionString,
  saveConnectionStringToEnvLocal,
  testConnectionString,
  viewFromEnv,
} from "@/src/lib/dbConfig";

export async function GET() {
  return NextResponse.json(viewFromEnv());
}

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const cs = buildConnectionString({
      dialect: body.dialect,
      host: body.host,
      port: body.port,
      username: body.username,
      password: body.password,
      database: body.database,
    });

    if (!cs) {
      return NextResponse.json(
        { success: false, error: "No connection details supplied." },
        { status: 400 },
      );
    }

    const test = await testConnectionString(cs);
    if (!test.ok) {
      return NextResponse.json(
        { success: false, error: `Connection test failed: ${test.error}` },
        { status: 400 },
      );
    }

    await saveConnectionStringToEnvLocal(cs);

    return NextResponse.json({
      success: true,
      restartRequired: true,
      message:
        "Saved to .env.local. Restart the dev server (Ctrl+C and `npm run dev`) for the new connection to take effect.",
    });
  } catch (err: any) {
    return NextResponse.json(
      { success: false, error: err?.message || String(err) },
      { status: 500 },
    );
  }
}
