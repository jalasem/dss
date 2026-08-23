import keygen from 'ssh-keygen';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';

export async function generateSSHKey(spaceName: string, email: string): Promise<string> {
  // Construct the path for ~/.dss/spaces
  const dssPath = path.join(os.homedir(), '.dss', 'spaces');
  const spaceFolderPath = path.join(dssPath, spaceName);
  
  // Ensure the space's folder exists
  await fs.ensureDir(spaceFolderPath);

  // Path for the new SSH key within the space's folder
  const keyPath = path.join(spaceFolderPath, 'id_rsa');

  return new Promise((resolve, reject) => {
    keygen({
      location: keyPath,
      comment: email,
      password: '',
      read: true,
    }, function(err: Error | null) {
      if (err) {
        console.error('SSH key generation failed:', err);
        return reject(err);
      }
      console.log('Generated SSH key at:', keyPath);
      resolve(keyPath); // Return the full path to the generated key
    });
  });
}
