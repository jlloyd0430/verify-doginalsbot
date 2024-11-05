import dotenv from 'dotenv';
import pkg from 'discord.js';
import mongoose from 'mongoose';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const { Client, GatewayIntentBits, Collection } = pkg;
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Connect to MongoDB without deprecated options
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('Connected to MongoDB'))
  .catch((error) => console.error('MongoDB connection error:', error));

// Define User schema to support multiple wallet addresses
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

// Define Guild Settings schema to store role and collection/token configuration
const guildSettingsSchema = new mongoose.Schema({
  guildID: String,
  roleID: String,
  collectionName: String,
  requiredCount: Number,
  tokenTicker: String,
  requiredTokenAmount: Number,
});
const GuildSettings = mongoose.model('GuildSettings', guildSettingsSchema);

// Initialize the Discord client
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);

  try {
    console.log("Registering global commands...");

    // Register the setup commands for both inscription and token verification
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
    ]);

    console.log("Global commands registered successfully.");
    setInterval(checkWallets, 60000); // Periodically check wallets every 60 seconds
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

      // Save settings to MongoDB for collection-based verification
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

      // Save settings to MongoDB for token-based verification
      await GuildSettings.findOneAndUpdate(
        { guildID: interaction.guild.id },
        { roleID: role.id, tokenTicker, requiredTokenAmount },
        { upsert: true }
      );

      await interaction.editReply(`Token setup complete! Assigned role: ${role.name} for token ${tokenTicker} with required amount: ${requiredTokenAmount}`);
    }
  } catch (error) {
    console.error('Error handling interaction:', error);
    await interaction.editReply('There was an error processing the command.');
  }
});

// Function to check wallet inscriptions and tokens, and update roles accordingly
async function checkWallets() {
  console.log("Starting wallet check...");

  const guildSettings = await GuildSettings.find();
  if (guildSettings.length === 0) {
    console.log("No guild settings found. Make sure to run /setup or /settoken commands.");
    return;
  }

  for (const settings of guildSettings) {
    const { roleID, collectionName, requiredCount, tokenTicker, requiredTokenAmount } = settings;
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

    const users = await User.find();
    for (const user of users) {
      for (const wallet of user.walletAddresses) {
        const member = await guild.members.fetch(user.discordID).catch(() => null);
        if (!member) continue;

        const holdsInscriptions = collectionName 
          ? await checkForRequiredInscriptions(wallet.address, collectionName, requiredCount)
          : false;

        const holdsTokens = tokenTicker
          ? await checkForRequiredTokens(wallet.address, tokenTicker, requiredTokenAmount)
          : false;

        if ((holdsInscriptions || holdsTokens) && !member.roles.cache.has(roleID)) {
          await member.roles.add(role);
          console.log(`Granted role ${role.name} to ${member.user.tag}`);
        } else if (!(holdsInscriptions || holdsTokens) && member.roles.cache.has(roleID)) {
          await member.roles.remove(role);
          console.log(`Revoked role ${role.name} from ${member.user.tag}`);
        }
      }
    }
  }
}

// Function to check for required inscriptions using the Maestro API
async function checkForRequiredInscriptions(address, collectionName, requiredCount) {
  console.log(`Checking inscriptions for wallet address: ${address}`);
  try {
    const headers = { 'api-key': process.env.MAESTRO_API_KEY };
    let allInscriptions = [];
    let cursor = null;

    do {
      const response = await fetch(`https://xdg-mainnet.gomaestro-api.org/v0/addresses/${address}/utxos${cursor ? `?cursor=${cursor}` : ''}`, {
        method: 'GET',
        headers,
      });

      if (!response.ok) throw new Error(`API error: ${response.statusText}`);
      const data = await response.json();

      const inscriptions = data.data.flatMap((utxo) => utxo.inscriptions.map(i => i.inscription_id) || []);
      allInscriptions.push(...inscriptions);
      cursor = data.next_cursor;
    } while (cursor);

    // Check if wallet has the required number of inscriptions
    const matchingInscriptions = allInscriptions.filter(inscription => inscription === collectionName);
    return matchingInscriptions.length >= requiredCount;
  } catch (error) {
    console.error('Error checking inscriptions:', error);
    return false;
  }
}

// Function to check for required DRC-20 tokens using the Maestro API
async function checkForRequiredTokens(address, tokenTicker, requiredTokenAmount) {
  const headers = { 'api-key': process.env.MAESTRO_API_KEY };
  try {
    const response = await fetch(`https://xdg-mainnet.gomaestro-api.org/v0/addresses/${address}/drc20`, {
      method: 'GET',
      headers,
    });
    if (!response.ok) throw new Error(`API error: ${response.statusText}`);
    
    const data = await response.json();
    
    // Get token data by ticker
    const tokenData = data.data[tokenTicker];
    if (!tokenData) {
      console.log(`Token ${tokenTicker} not found for address ${address}.`);
      return false;
    }
    
    // Check if available balance meets required amount
    const availableBalance = parseFloat(tokenData.available);
    return availableBalance >= requiredTokenAmount;
  } catch (error) {
    console.error(`Error checking tokens for ${address}:`, error);
    return false;
  }
}

client.login(process.env.DISCORD_BOT_TOKEN);
