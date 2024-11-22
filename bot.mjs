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

// Sub-schema for criteria
const criteriaSchema = new mongoose.Schema({
  type: { type: String, required: true }, // 'nft', 'token', or 'dune'
  collectionName: String, // For NFTs
  requiredCount: Number, // For NFTs and Dunes
  tokenTicker: String, // For DRC-20 Tokens
  requiredTokenAmount: Number, // For DRC-20 Tokens
  duneID: String, // For Dunes
  requiredDuneAmount: Number, // For Dunes
});

// Sub-schema for roles
const roleSchema = new mongoose.Schema({
  roleID: { type: String, required: true },
  criteria: { type: criteriaSchema, required: true },
});

// Guild settings schema
const guildSettingsSchema = new mongoose.Schema({
  guildID: { type: String, required: true },
  roles: [roleSchema],
});

const GuildSettings = mongoose.model('GuildSettings', guildSettingsSchema);

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

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });

async function registerCommands() {
  try {
    console.log("Registering commands...");
    await client.application.commands.set([
      {
        name: 'setup',
        description: 'Set up role for NFTs',
        options: [
          { name: 'role', type: 8, description: 'Role to assign', required: true },
          { name: 'collection', type: 3, description: 'Collection name', required: true },
          { name: 'required_count', type: 4, description: 'Minimum number of NFTs required', required: true },
        ],
      },
      {
        name: 'settoken',
        description: 'Set up role for DRC-20 tokens',
        options: [
          { name: 'role', type: 8, description: 'Role to assign', required: true },
          { name: 'token_ticker', type: 3, description: 'Token ticker', required: true },
          { name: 'required_token_amount', type: 4, description: 'Minimum amount required', required: true },
        ],
      },
      {
        name: 'setdune',
        description: 'Set up role for Dunes',
        options: [
          { name: 'role', type: 8, description: 'Role to assign', required: true },
          { name: 'dune_id', type: 3, description: 'Dune ID', required: true },
          { name: 'required_dune_amount', type: 4, description: 'Minimum amount required', required: true },
        ],
      },
    ]);
    console.log("Commands registered successfully.");
  } catch (error) {
    console.error("Error registering commands:", error);
  }
}

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  await registerCommands();

  setInterval(async () => {
    try {
      console.log("Checking wallets...");
      await checkWallets();
    } catch (error) {
      console.error("Error in wallet check:", error);
    }
  }, 60000);
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isCommand()) return;

  try {
    await interaction.deferReply({ ephemeral: true });

    const role = interaction.options.getRole('role');
    if (interaction.commandName === 'setup') {
      const collectionName = interaction.options.getString('collection');
      const requiredCount = interaction.options.getInteger('required_count');

      await GuildSettings.findOneAndUpdate(
        { guildID: interaction.guild.id },
        {
          $push: {
            roles: { roleID: role.id, criteria: { type: 'nft', collectionName, requiredCount } },
          },
        },
        { upsert: true }
      );

      await interaction.editReply(`NFT role setup complete for ${role.name} with collection ${collectionName}.`);

    } else if (interaction.commandName === 'settoken') {
      const tokenTicker = interaction.options.getString('token_ticker');
      const requiredTokenAmount = interaction.options.getInteger('required_token_amount');

      await GuildSettings.findOneAndUpdate(
        { guildID: interaction.guild.id },
        {
          $push: {
            roles: { roleID: role.id, criteria: { type: 'token', tokenTicker, requiredTokenAmount } },
          },
        },
        { upsert: true }
      );

      await interaction.editReply(`Token role setup complete for ${role.name} with ticker ${tokenTicker}.`);

    } else if (interaction.commandName === 'setdune') {
      const duneID = interaction.options.getString('dune_id');
      const requiredDuneAmount = interaction.options.getInteger('required_dune_amount');

      await GuildSettings.findOneAndUpdate(
        { guildID: interaction.guild.id },
        {
          $push: {
            roles: { roleID: role.id, criteria: { type: 'dune', duneID, requiredDuneAmount } },
          },
        },
        { upsert: true }
      );

      await interaction.editReply(`Dune role setup complete for ${role.name} with Dune ID ${duneID}.`);
    }
  } catch (error) {
    console.error("Error handling interaction:", error);
    if (!interaction.replied) {
      await interaction.editReply("An error occurred while processing the command.");
    }
  }
});

async function checkWallets() {
  const guildSettings = await GuildSettings.find();
  for (const settings of guildSettings) {
    const guild = client.guilds.cache.get(settings.guildID);
    if (!guild) continue;

    for (const roleSettings of settings.roles) {
      const { roleID, criteria } = roleSettings;
      const role = guild.roles.cache.get(roleID);
      if (!role) continue;

      const users = await User.find();
      for (const user of users) {
        const member = await guild.members.fetch(user.discordID).catch(() => null);
        if (!member) continue;

        let hasRole = false;

        if (criteria.type === 'nft') {
          hasRole = await checkForRequiredInscriptions(
            user.walletAddresses, 
            criteria.collectionName, 
            criteria.requiredCount
          );
        } else if (criteria.type === 'token') {
          hasRole = await checkForRequiredTokens(
            user.walletAddresses, 
            criteria.tokenTicker, 
            criteria.requiredTokenAmount
          );
        } else if (criteria.type === 'dune') {
          hasRole = await checkForRequiredDunes(
            user.walletAddresses, 
            criteria.duneID, 
            criteria.requiredDuneAmount
          );
        }

        if (hasRole && !member.roles.cache.has(roleID)) {
          await member.roles.add(role);
          console.log(`Added role ${role.name} to ${member.user.tag}`);
        } else if (!hasRole && member.roles.cache.has(roleID)) {
          await member.roles.remove(role);
          console.log(`Removed role ${role.name} from ${member.user.tag}`);
        }
      }
    }
  }
}

// Add the check functions here: checkForRequiredInscriptions, checkForRequiredTokens, checkForRequiredDunes
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
