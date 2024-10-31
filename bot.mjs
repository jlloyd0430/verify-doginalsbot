import dotenv from 'dotenv';
import pkg from 'discord.js';
import mongoose from 'mongoose';
import fs from 'fs';
import path from 'path';

const { Client, GatewayIntentBits, Collection } = pkg;

// Import node-fetch dynamically
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

// Load environment variables
dotenv.config();

// Connect to MongoDB
mongoose.connect(process.env.MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => console.log('Connected to MongoDB'))
  .catch((error) => console.error('MongoDB connection error:', error));

// Define User schema
const userSchema = new mongoose.Schema({
  discordID: String,
  walletAddress: String,
});
const User = mongoose.model('User', userSchema);

// Initialize the Discord client
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });

// Store server-specific settings in memory
const serverSettings = new Collection();

// Register commands
client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);

  // Register the /setup command
  await client.application.commands.create({
    name: 'setup',
    description: 'Set up role and collection name for verification',
    options: [
      {
        name: 'role',
        type: 8, // Role type
        description: 'Role to assign',
        required: true,
      },
      {
        name: 'collection',
        type: 3, // String type
        description: 'Collection name (e.g., dmb)',
        required: true,
      },
      {
        name: 'required_count',
        type: 4, // Integer type
        description: 'Number of inscriptions required to assign role',
        required: true,
      }
    ]
  });

  // Register the /setcollectionname command
  await client.application.commands.create({
    name: 'setcollectionname',
    description: 'Set collection name for verification',
    options: [
      {
        name: 'collection',
        type: 3, // String type
        description: 'Collection name to reference for verification',
        required: true,
      }
    ]
  });

  setInterval(checkWallets, 60000); // Periodically check wallets every 60 seconds
});

// Handle interactions for commands
client.on('interactionCreate', async interaction => {
  if (!interaction.isCommand()) return;

  if (interaction.commandName === 'setup') {
    const role = interaction.options.getRole('role');
    const collectionName = interaction.options.getString('collection');
    const requiredCount = interaction.options.getInteger('required_count');

    // Save server settings
    serverSettings.set(interaction.guild.id, { roleID: role.id, collectionName, requiredCount });
    await interaction.reply(`Setup complete! Assigned role: ${role.name} for collection ${collectionName} with required count: ${requiredCount}`);
  }

  if (interaction.commandName === 'setcollectionname') {
    const collectionName = interaction.options.getString('collection');
    const collectionPath = path.join(__dirname, 'collections', `${collectionName}.json`);

    // Check if the collection file exists
    if (fs.existsSync(collectionPath)) {
      const guildSettings = serverSettings.get(interaction.guild.id) || {};
      guildSettings.collectionName = collectionName;
      serverSettings.set(interaction.guild.id, guildSettings);

      await interaction.reply(`Collection name set to ${collectionName} for verification.`);
    } else {
      await interaction.reply(`Collection file ${collectionName}.json does not exist.`);
    }
  }
});

// Function to check wallet inscriptions
async function checkWallets() {
  for (const [guildId, settings] of serverSettings) {
    const { roleID, collectionName, requiredCount } = settings;
    const guild = client.guilds.cache.get(guildId);
    const role = guild.roles.cache.get(roleID);

    // Load collection data
    const collectionPath = path.join(__dirname, 'collections', `${collectionName}.json`);
    if (!fs.existsSync(collectionPath)) {
      console.log(`Collection file not found: ${collectionName}.json`);
      continue;
    }
    const collectionData = JSON.parse(fs.readFileSync(collectionPath, 'utf-8'));

    // Get all users and check inscriptions
    const users = await User.find();
    for (const user of users) {
      const holdsRequiredInscriptions = await checkForRequiredInscriptions(user.walletAddress, collectionData.inscriptions, requiredCount);
      
      const member = await guild.members.fetch(user.discordID).catch(() => null);
      if (member) {
        if (holdsRequiredInscriptions && !member.roles.cache.has(roleID)) {
          await member.roles.add(role);
          console.log(`Granted role to ${member.user.tag}`);
        } else if (!holdsRequiredInscriptions && member.roles.cache.has(roleID)) {
          await member.roles.remove(role);
          console.log(`Revoked role from ${member.user.tag}`);
        }
      }
    }
  }
}

// Function to check for required inscriptions using Maestro API
async function checkForRequiredInscriptions(address, inscriptionList, requiredCount) {
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
      const inscriptions = data.data.flatMap((utxo) => utxo.inscriptions || []);
      allInscriptions.push(...inscriptions);
      cursor = data.next_cursor;
    } while (cursor);

    // Count matches
    const matchingInscriptions = allInscriptions.filter(inscription => inscriptionList.includes(inscription));
    return matchingInscriptions.length >= requiredCount;
  } catch (error) {
    console.error('Error checking inscriptions:', error);
    return false;
  }
}

// Log in to Discord
client.login(process.env.DISCORD_BOT_TOKEN);
