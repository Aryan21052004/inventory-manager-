import { redirect } from "next/navigation";

/**
 * There is no marketing page — the root is just a doorway into the app.
 */
export default function Home() {
  redirect("/dashboard");
}
