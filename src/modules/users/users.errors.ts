export class UserEmailConflictError extends Error {
  constructor() {
    super('Email is already in use');
    this.name = 'UserEmailConflictError';
  }
}

export class UserPersistenceError extends Error {
  constructor() {
    super('User persistence operation failed');
    this.name = 'UserPersistenceError';
  }
}

export class UserNotFoundError extends Error {}
export class UserPasswordChangedError extends Error {}
