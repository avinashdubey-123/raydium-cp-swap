#!/usr/bin/env node
// Simple utility to print Solana keypair details.
// Usage: node scripts/print_key.js [path/to/keypair.json]
// Default path: ~/.config/solana/id.json

const fs = require('fs');
const path = require('path');
const os = require('os');

const arg = process.argv[2];
const defaultPath = path.join(os.homedir(), '.config', 'solana', 'id.json');
const keyPath = arg || defaultPath;

function safeExit(msg, code = 1) {
  if (msg) console.error(msg);
  process.exit(code);
}

try {
  const raw = fs.readFileSync(keyPath, 'utf8');
  const arr = JSON.parse(raw);
  if (!Array.isArray(arr)) safeExit('Keyfile JSON is not an array of numbers');
  const buf = Buffer.from(arr);

  console.log('Key path:', keyPath);
  console.log('Full secret (array length):', arr.length);
  console.log('');
  console.log('Full secret (CSV):');
  console.log(arr.join(','));
  console.log('');

  const secret32 = buf.slice(0, 32);
  console.log('Secret (first 32 bytes) hex:', secret32.toString('hex'));
  console.log('Secret (first 32 bytes) base64:', secret32.toString('base64'));
  console.log('');
  console.log('Full secret hex:', buf.toString('hex'));
  console.log('Full secret base64:', buf.toString('base64'));
  console.log('');

  // Try to extract public key
  if (buf.length >= 64) {
    const pubkeyBuf = buf.slice(32, 64);
    console.log('Public key (hex):', pubkeyBuf.toString('hex'));
    // Minimal base58 encode (no deps)
    const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    function base58Encode(buffer) {
      const digits = [0];
      for (let i = 0; i < buffer.length; ++i) {
        let carry = buffer[i];
        for (let j = 0; j < digits.length; ++j) {
          const x = digits[j] * 256 + carry;
          digits[j] = x % 58;
          carry = (x / 58) | 0;
        }
        while (carry) {
          digits.push(carry % 58);
          carry = (carry / 58) | 0;
        }
      }
      let str = '';
      for (let k = 0; k < buffer.length && buffer[k] === 0; ++k) str += '1';
      for (let q = digits.length - 1; q >= 0; --q) str += ALPHABET[digits[q]];
      return str;
    }

    try {
      console.log('Public key (base58):', base58Encode(pubkeyBuf));
    } catch (e) {
      console.log('Public key (base58): <error encoding>');
    }
  } else if (buf.length === 32) {
    console.log('Keypair appears to be a 32-byte seed; public key not included in file.');
    console.log('To derive the public key, install a library like @solana/web3.js or tweetnacl.');
  } else {
    console.log('Unable to determine public key from keyfile (unexpected length).');
  }
} catch (err) {
  safeExit('Error reading/parsing keyfile: ' + err.message);
}
