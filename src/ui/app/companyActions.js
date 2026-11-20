import { findCompany, setPayPeriod, storedPeriod } from "../../domain/payPeriod.js";

/**
 * What the Companies list in Settings does: change one client's payday.
 *
 * Undo writes the previous schedule back as a NEW edit through `setPayPeriod`,
 * so it is stamped and syncs like the change it reverses. Putting an old copy
 * of the list back would carry old stamps and lose to the edit on the next
 * merge.
 */
export function companyActions({ commit, flash, stateRef }) {
  return {
    onSaveCompanyPayday: (name, rule) => {
      const before = storedPeriod(findCompany(stateRef.current, name)?.payPeriod) ?? null;
      commit((s) => setPayPeriod(s, name, rule, Date.now()));
      flash(`Payday saved for ${name}.`, "Undo",
        () => commit((s) => setPayPeriod(s, name, before, Date.now())));
    },
  };
}
