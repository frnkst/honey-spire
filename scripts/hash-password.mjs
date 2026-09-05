import { hash } from "@node-rs/argon2";

async function readStandardInput() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

const password = process.argv[2] ?? (await readStandardInput());
if (!password || password.length < 12) {
  console.error("Administrator password must contain at least 12 characters.");
  process.exit(1);
}

process.stdout.write(
  await hash(password, {
    algorithm: 2,
    memoryCost: 19_456,
    timeCost: 2,
    parallelism: 1,
  }),
);
