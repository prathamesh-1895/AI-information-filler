/** Error types the UI can tell apart. Messages are user-readable and never contain vault values. */

export class VaultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class VaultLockedError extends VaultError {
  constructor() {
    super('Your vault is locked. Unlock it with your passphrase to continue.');
  }
}

export class VaultNotInitializedError extends VaultError {
  constructor() {
    super('No vault exists yet. Create one to get started.');
  }
}

export class VaultExistsError extends VaultError {
  constructor() {
    super('A vault already exists on this device.');
  }
}

export class WrongPassphraseError extends VaultError {
  constructor() {
    super('That passphrase is not correct.');
  }
}

export class WeakPassphraseError extends VaultError {
  constructor(minLength: number) {
    super(`Your passphrase must be at least ${minLength} characters long.`);
  }
}

/** A write was refused by policy (denied value, sensitivity downgrade, invalid record). */
export class VaultValidationError extends VaultError {}

export class BackupFormatError extends VaultError {}
