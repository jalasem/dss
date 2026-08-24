export interface ISpace {
  name: string;
  email: string;
  userName: string;
  sshKeyPath: string;
  host?: string;
}

export interface IConfig {
  spaces: ISpace[];
  activeSpace?: string;
}

export interface IKeyInfo {
  path: string;
  algorithm: 'ed25519' | 'rsa' | 'unknown';
  createdAt?: string;
  fingerprint?: string;
}

export interface IIdentity {
  name: string;
  email: string;
  userName: string;
  host: string;
  key?: IKeyInfo;
}

export interface IBinding {
  path: string;
  identity: string;
}

/** A directory rule: `identity` applies automatically to any Git repository
 * whose (canonical, absolute) directory falls under `dir` — compiled to a
 * native `includeIf "gitdir:<dir>/"` section in ~/.dss/rules.gitconfig. */
export interface IRule {
  dir: string;
  identity: string;
}

export interface IStoreV2 {
  version: 2;
  identities: IIdentity[];
  active?: string;
  bindings: IBinding[];
  rules: IRule[];
}
