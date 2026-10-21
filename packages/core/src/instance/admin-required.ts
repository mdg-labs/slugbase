/**
 * An instance operation was refused by the database because the account of the request is no longer an enabled instance
 * admin with a second factor: the check the `instanceAdmin` policy made was true when the request was admitted, and another
 * admin's committed change took the account's standing away before the operation ran (doc 05 section 7.1). Nothing was
 * changed or written. It is thrown inside the tenant transaction, which rolls back, and the routes answer it `403 forbidden`.
 */
export class InstanceAdminRequiredError extends Error {
  constructor(options: { readonly cause: unknown }) {
    super("the account of the request is no longer an enabled instance admin with a second factor", options);
    this.name = "InstanceAdminRequiredError";
  }
}
