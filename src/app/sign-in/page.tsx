import { redirect } from "next/navigation";
import { SignInForm } from "@/components/sign-in-form";
import { getCurrentMember } from "@/lib/session";

export default async function SignInPage() {
  if (await getCurrentMember()) redirect("/search");
  return (
    <div className="mx-auto mt-10 max-w-sm">
      <div className="card">
        <h1 className="text-xl font-semibold">Sign in</h1>
        <p className="mt-1 text-sm text-muted">Accounts are issued by the MLS.</p>
        <SignInForm />
      </div>
    </div>
  );
}
