export interface ISpace {
  name: string;
  email: string;
  userName: string;
  sshKeyPath: string;
}

export interface IConfig {
  spaces: ISpace[];
  activeSpace?: string;
}
