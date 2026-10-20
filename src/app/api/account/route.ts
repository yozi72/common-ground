import { handle, ok, requireUser } from "@/lib/api";
import { supabaseAdmin } from "@/lib/supabase/admin";

// Account and data deletion. Ends live state, then deletes the auth user; every
// app table cascades from accounts → auth.users. Immediate, not reversible.
export async function DELETE() {
  return handle(async () => {
    const { user } = await requireUser();
    const admin = supabaseAdmin();
    const { error: e1 } = await admin.rpc("prepare_account_deletion", { p_account: user.id });
    if (e1) throw new Error(e1.message);
    const { error: e2 } = await admin.auth.admin.deleteUser(user.id);
    if (e2) throw new Error(e2.message);
    return ok({ deleted: true });
  });
}
