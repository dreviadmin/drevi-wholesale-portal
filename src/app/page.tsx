import { redirect } from "next/navigation";

// The portal has no public landing — route everyone to login.
export default function Home() {
  redirect("/login");
}
