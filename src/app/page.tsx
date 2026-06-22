import App from '../App';
import { redirect } from "next/navigation";
import { getSession } from "../lib/api-auth";

export default async function Home() {
  const session = await getSession();
  if (!session) redirect("/login");
  return <App />;
}
