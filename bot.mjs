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

async function registerCommands() {
  try {
    console.log("Refreshing and registering application commands...");
    await client.application.commands.set([
      {
        name: 'setup',
        description: 'Set up role and collection name for verification',
        options: [
          { name: 'role', type: 8, description: 'Role to assign', required: true },
          { name: 'collection', type: 3, description: 'Collection name (e.g., dmb)', required: true },
          { name: 'required_count', type: 4, description: 'Number of inscriptions required to assign role', required: true },
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
    console.log("Application commands registered successfully.");
  } catch (error) {
    console.error("Error registering commands:", error);
  }
}

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  await registerCommands(); // Refresh commands on bot startup

  setInterval(() => {
    console.log("Running `checkWallets` interval...");
    checkWallets().catch(error => console.error("Error in `checkWallets`:", error));
  }, 180000); // Periodically check wallets every 60 seconds
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
      console.log(`Setup command executed for guild ${interaction.guild.id}`);

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
    if (!interaction.replied) {
      await interaction.editReply('There was an error while processing the command. Please check the logs for more details.');
    }
  }
});

async function checkWallets() {
  console.log("Starting wallet check...");
  const guildSettings = await GuildSettings.find();
  if (guildSettings.length === 0) {
    console.log("No guild settings found. Make sure to run /setup or /setcollectionname commands.");
    return;
  }
  for (const settings of guildSettings) {
    console.log(`Processing settings for guild ID: ${settings.guildID}`, settings);
    const { roleID, collectionName, requiredCount, tokenTicker, requiredTokenAmount, duneID, requiredDuneAmount } = settings;
    const guild = client.guilds.cache.get(settings.guildID);
    if (!guild) {
      console.error(`Guild with ID ${settings.guildID} not found.`);
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

    const collectionData = JSON.parse(fs.readFileSync(collectionPath, 'utf-8'));
    const inscriptionList = collectionData.map((item) => item.inscriptionId);
    const users = await User.find();
    console.log(`Found ${users.length} users in the database.`);
    for (const user of users) {
      for (const wallet of user.walletAddresses) {
        console.log(`Checking for user ${user.discordID}, Wallet Address: ${wallet.address}`);

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
}

// Function to check for inscriptions using Maestro API
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

// Function to check for required DRC-20 tokens
async function checkForRequiredTokens(address, tokenTicker, requiredTokenAmount) {
  const headers = { 'api-key': process.env.MAESTRO_API_KEY };
  try {
    const response = await fetch(`https://xdg-mainnet.gomaestro-api.org/v0/addresses/${address}/drc20`, {
      method: 'GET',
      headers,
    });
    if (!response.ok) throw new Error(`API error: ${response.statusText}`);

    const data = await response.json();
    const tokenData = data.data[tokenTicker];
    if (!tokenData) {
      console.log(`Token ${tokenTicker} not found for address ${address}.`);
      return false;
    }

    const availableBalance = parseFloat(tokenData);
    console.log(`Wallet ${address} holds ${availableBalance} of ${tokenTicker} (Required: ${requiredTokenAmount}).`);
    return availableBalance >= requiredTokenAmount;
  } catch (error) {
    console.error(`Error checking tokens for ${address}:`, error);
    return false;
  }
}

// Function to check for required dunes
async function checkForRequiredDunes(address, duneID, requiredDuneAmount) {
  const headers = { 'api-key': process.env.MAESTRO_API_KEY };
  try {
    const response = await fetch(`https://xdg-mainnet.gomaestro-api.org/v0/addresses/${address}/dunes`, {
      method: 'GET',
      headers,
    });
    if (!response.ok) throw new Error(`API error: ${response.statusText}`);

    const data = await response.json();
    const duneData = data.data[duneID];
    if (!duneData) {
      console.log(`Dune ${duneID} not found for address ${address}.`);
      return false;
    }

    const availableAmount = parseFloat(duneData);
    console.log(`Wallet ${address} holds ${availableAmount} of Dune ${duneID} (Required: ${requiredDuneAmount}).`);
    return availableAmount >= requiredDuneAmount;
  } catch (error) {
    console.error(`Error checking dunes for ${address}:`, error);
    return false;
  }
}

client.login(process.env.DISCORD_BOT_TOKEN);
