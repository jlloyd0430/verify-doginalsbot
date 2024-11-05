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

// Define Guild Settings schema to store role and collection configuration
const guildSettingsSchema = new mongoose.Schema({
  guildID: String,
  roleID: String,
  collectionName: String,
  requiredCount: Number,
});
const GuildSettings = mongoose.model('GuildSettings', guildSettingsSchema);
// Initialize the Discord client
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);

  try {
    console.log("Registering global commands...");
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
        name: 'setcollectionname',
        description: 'Set collection name for verification',
        options: [
          { name: 'collection', type: 3, description: 'Collection name to reference for verification', required: true },
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

  console.log(`Received command: ${interaction.commandName}`);

  try {
    await interaction.deferReply({ ephemeral: true });

    if (interaction.commandName === 'setup') {
      const role = interaction.options.getRole('role');
      const collectionName = interaction.options.getString('collection');
      const requiredCount = interaction.options.getInteger('required_count');

      // Save settings to MongoDB
      await GuildSettings.findOneAndUpdate(
        { guildID: interaction.guild.id },
        { roleID: role.id, collectionName, requiredCount },
        { upsert: true }
      );

      await interaction.editReply(`Setup complete! Assigned role: ${role.name} for collection ${collectionName} with required count: ${requiredCount}`);
      console.log(`Setup command executed for guild ${interaction.guild.id}`);

    } else if (interaction.commandName === 'setcollectionname') {
      const collectionName = interaction.options.getString('collection');
      const collectionPath = path.join(__dirname, 'collections', `${collectionName}.json`);

      if (fs.existsSync(collectionPath)) {
        await GuildSettings.findOneAndUpdate(
          { guildID: interaction.guild.id },
          { collectionName },
          { upsert: true }
        );
        await interaction.editReply(`Collection name set to ${collectionName} for verification.`);
        console.log(`Set collection name to ${collectionName} for guild ${interaction.guild.id}`);
      } else {
        await interaction.editReply(`Collection file ${collectionName}.json does not exist.`);
        console.log(`Collection file ${collectionName}.json not found.`);
      }
    }
  } catch (error) {
    console.error('Error handling interaction:', error);
    if (!interaction.replied) {
      await interaction.editReply('There was an error while processing the command. Please check the logs for more details.');
    }
  }
});

// Function to check wallet inscriptions and update roles
async function checkWallets() {
  console.log("Starting wallet check...");
  const guildSettings = await GuildSettings.find();
  if (guildSettings.length === 0) {
    console.log("No guild settings found. Make sure to run /setup or /setcollectionname commands.");
    return;
  }
  for (const settings of guildSettings) {
    console.log(`Processing settings for guild ID: ${settings.guildID}`, settings);
    const { roleID, collectionName, requiredCount } = settings;
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
        console.log(`Checking inscriptions for user with Discord ID: ${user.discordID}, Wallet Address: ${wallet.address}`);
        const holdsRequiredInscriptions = await checkForRequiredInscriptions(wallet.address, inscriptionList, requiredCount);
        const member = await guild.members.fetch(user.discordID).catch(() => null);
        if (member) {
          if (holdsRequiredInscriptions && !member.roles.cache.has(roleID)) {
            await member.roles.add(role);
            console.log(`Granted role ${role.name} to ${member.user.tag}`);
          } else if (!holdsRequiredInscriptions && member.roles.cache.has(roleID)) {
            await member.roles.remove(role);
            console.log(`Revoked role ${role.name} from ${member.user.tag}`);
          } else {
            console.log(`No role change required for ${member.user.tag}`);
          }
        } else {
          console.log(`User with Discord ID ${user.discordID} not found in guild.`);
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

// Log in to Discord
client.login(process.env.DISCORD_BOT_TOKEN);
