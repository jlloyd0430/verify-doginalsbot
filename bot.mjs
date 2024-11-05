import dotenv from 'dotenv';
import pkg from 'discord.js';
import mongoose from 'mongoose';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const { Client, GatewayIntentBits } = pkg;
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('Connected to MongoDB'))
  .catch((error) => console.error('MongoDB connection error:', error));

const userSchema = new mongoose.Schema({
  discordID: String,
  walletAddresses: [
    {
      address: String,
      provider: String,
    },
  ],
});
const User = mongoose.model('User', userSchema);

const guildSettingsSchema = new mongoose.Schema({
  guildID: String,
  roleID: String,
  collectionName: String,
  requiredCount: Number,
  tokenTicker: String,
  requiredTokenAmount: Number,
  duneID: String,
  requiredDuneAmount: Number,
});
const GuildSettings = mongoose.model('GuildSettings', guildSettingsSchema);

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);

  try {
    console.log("Registering global commands...");

    await client.application.commands.set([
      {
        name: 'setup',
        description: 'Set up role and collection for NFT verification',
        options: [
          { name: 'role', type: 8, description: 'Role to assign', required: true },
          { name: 'collection', type: 3, description: 'Collection name (e.g., dmb)', required: true },
          { name: 'required_count', type: 4, description: 'Number of inscriptions required', required: true },
        ],
      },
      {
        name: 'settoken',
        description: 'Set token for role verification',
        options: [
          { name: 'role', type: 8, description: 'Role to assign', required: true },
          { name: 'token_ticker', type: 3, description: 'Token ticker (e.g., DOGE)', required: true },
          { name: 'required_token_amount', type: 4, description: 'Minimum amount of tokens required', required: true },
        ],
      },
      {
        name: 'setdune',
        description: 'Set Dune for role verification',
        options: [
          { name: 'role', type: 8, description: 'Role to assign', required: true },
          { name: 'dune_id', type: 3, description: 'Dune ID to verify (e.g., 5244142:13)', required: true },
          { name: 'required_dune_amount', type: 4, description: 'Minimum amount of dunes required', required: true },
        ],
      },
    ]);

    console.log("Global commands registered successfully.");

    // Schedule the `checkWallets` function to run every 60 seconds
    setInterval(() => {
      console.log("Running `checkWallets` interval...");
      checkWallets().catch(error => console.error("Error in `checkWallets`:", error));
    }, 60000);

  } catch (error) {
    console.error("Error registering commands:", error);
  }
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isCommand()) return;

  try {
    await interaction.deferReply({ ephemeral: true });

    if (interaction.commandName === 'setup') {
      const role = interaction.options.getRole('role');
      const collectionName = interaction.options.getString('collection');
      const requiredCount = interaction.options.getInteger('required_count');

      await GuildSettings.findOneAndUpdate(
        { guildID: interaction.guild.id },
        { roleID: role.id, collectionName, requiredCount },
        { upsert: true }
      );

      await interaction.editReply(`Setup complete! Assigned role: ${role.name} for collection ${collectionName} with required count: ${requiredCount}`);

    } else if (interaction.commandName === 'settoken') {
      const role = interaction.options.getRole('role');
      const tokenTicker = interaction.options.getString('token_ticker');
      const requiredTokenAmount = interaction.options.getInteger('required_token_amount');

      await GuildSettings.findOneAndUpdate(
        { guildID: interaction.guild.id },
        { roleID: role.id, tokenTicker, requiredTokenAmount },
        { upsert: true }
      );

      await interaction.editReply(`Token setup complete! Assigned role: ${role.name} for token ${tokenTicker} with required amount: ${requiredTokenAmount}`);

    } else if (interaction.commandName === 'setdune') {
      const role = interaction.options.getRole('role');
      const duneID = interaction.options.getString('dune_id');
      const requiredDuneAmount = interaction.options.getInteger('required_dune_amount');

      await GuildSettings.findOneAndUpdate(
        { guildID: interaction.guild.id },
        { roleID: role.id, duneID, requiredDuneAmount },
        { upsert: true }
      );

      await interaction.editReply(`Dune setup complete! Assigned role: ${role.name} for dune ID ${duneID} with required amount: ${requiredDuneAmount}`);
    }
  } catch (error) {
    console.error('Error handling interaction:', error);
    await interaction.editReply('There was an error processing the command.');
  }
});

// Main function to check wallet inscriptions, tokens, and dunes, and update roles accordingly
async function checkWallets() {
  console.log("Starting `checkWallets` function...");

  try {
    const guildSettings = await GuildSettings.find();
    console.log(`Retrieved ${guildSettings.length} guild settings from MongoDB`);

    if (guildSettings.length === 0) {
      console.log("No guild settings found. Make sure to run /setup, /settoken, or /setdune commands.");
      return;
    }

    for (const settings of guildSettings) {
      const { roleID, collectionName, requiredCount, tokenTicker, requiredTokenAmount, duneID, requiredDuneAmount, guildID } = settings;
      console.log(`Processing guild ID: ${guildID}, Role ID: ${roleID}`);

      const guild = client.guilds.cache.get(guildID);
      if (!guild) {
        console.error(`Guild with ID ${guildID} not found.`);
        continue;
      }

      const role = guild.roles.cache.get(roleID);
      if (!role) {
        console.error(`Role with ID ${roleID} not found in guild ${guild.name}.`);
        continue;
      }

      const collectionPath = path.join(__dirname, 'collections', `${collectionName}.json`);
      if (!fs.existsSync(collectionPath)) {
        console.log(`Collection file not found: ${collectionName}.json`);
        continue;
      }

      const inscriptionList = JSON.parse(fs.readFileSync(collectionPath, 'utf-8')).map((item) => item.inscriptionId);
      console.log(`Loaded ${inscriptionList.length} inscriptions from ${collectionName}.json`);

      const users = await User.find();
      console.log(`Checking ${users.length} users in the database`);

      for (const user of users) {
        for (const wallet of user.walletAddresses) {
          console.log(`Checking wallet address: ${wallet.address} for user: ${user.discordID}`);

          const member = await guild.members.fetch(user.discordID).catch(() => null);
          if (!member) {
            console.log(`User with Discord ID ${user.discordID} not found in guild.`);
            continue;
          }

          const holdsInscriptions = collectionName && inscriptionList.length > 0
            ? await checkForRequiredInscriptions(wallet.address, inscriptionList, requiredCount)
            : false;

          const holdsTokens = tokenTicker
            ? await checkForRequiredTokens(wallet.address, tokenTicker, requiredTokenAmount)
            : false;

          const holdsDunes = duneID
            ? await checkForRequiredDunes(wallet.address, duneID, requiredDuneAmount)
            : false;

          if ((holdsInscriptions || holdsTokens || holdsDunes) && !member.roles.cache.has(roleID)) {
            await member.roles.add(role);
            console.log(`Granted role ${role.name} to ${member.user.tag}`);
          } else if (!(holdsInscriptions || holdsTokens || holdsDunes) && member.roles.cache.has(roleID)) {
            await member.roles.remove(role);
            console.log(`Revoked role ${role.name} from ${member.user.tag}`);
          }
        }
      }
    }
  } catch (error) {
    console.error("Error in `checkWallets` function:", error);
  }
}

// Function to check for required inscriptions using Maestro API
async function checkForRequiredInscriptions(address, inscriptionList, requiredCount) {
  console.log(`Checking inscriptions for wallet address: ${address}`);
  try {
    const headers = { 'api-key': process.env.MAESTRO_API_KEY };
    let allInscriptions = [];
    let cursor = null;

    do {
      console.log(`Calling Maestro API for address ${address} with cursor ${cursor || 'initial'}`);
      const response = await fetch(`https://xdg-mainnet.gomaestro-api.org/v0/addresses/${address}/utxos${cursor ? `?cursor=${cursor}` : ''}`, {
        method: 'GET',
        headers,
      });

      if (!response.ok) throw new Error(`API error: ${response.statusText}`);
      const data = await response.json();
      console.log(`Received data from Maestro API for ${address}:`, JSON.stringify(data, null, 2));

      const inscriptions = data.data.flatMap((utxo) => utxo.inscriptions.map(i => i.inscription_id) || []);
      allInscriptions.push(...inscriptions);
      cursor = data.next_cursor;
    } while (cursor);

    const matchingInscriptions = allInscriptions.filter(inscription => inscriptionList.includes(inscription));
    console.log(`Wallet ${address} holds ${matchingInscriptions.length} matching inscriptions (Required: ${requiredCount}).`);
    return matchingInscriptions.length >= requiredCount;
  } catch (error) {
    console.error('Error checking inscriptions:', error);
    return false;
  }
}

client.login(process.env.DISCORD_BOT_TOKEN);
