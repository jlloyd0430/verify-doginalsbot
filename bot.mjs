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

  try {
    // Clear existing commands for testing
    await client.application.commands.set([]); 

    // Register the /setup command
    const setupCommand = await client.application.commands.create({
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

    console.log("Setup command registered:", setupCommand);

    // Register the /setcollectionname command
    const collectionCommand = await client.application.commands.create({
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

    console.log("Setcollectionname command registered:", collectionCommand);

    setInterval(checkWallets, 60000); // Periodically check wallets every 60 seconds

  } catch (error) {
    console.error("Error registering commands:", error);
  }
});

// Handle interactions for commands
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isCommand()) return;

  console.log(`Received command: ${interaction.commandName}`); // Log the command name

  try {
    await interaction.deferReply({ ephemeral: true });

    if (interaction.commandName === 'setup') {
      console.log("Processing /setup command");

      const role = interaction.options.getRole('role');
      const collectionName = interaction.options.getString('collection');
      const requiredCount = interaction.options.getInteger('required_count');

      console.log(`Role: ${role.name}, Collection: ${collectionName}, Required Count: ${requiredCount}`);

      serverSettings.set(interaction.guild.id, { roleID: role.id, collectionName, requiredCount });
      await interaction.editReply({
        content: `Setup complete! Assigned role: ${role.name} for collection ${collectionName} with required count: ${requiredCount}`,
      });

    } else if (interaction.commandName === 'setcollectionname') {
      console.log("Processing /setcollectionname command");

      const collectionName = interaction.options.getString('collection');
      const collectionPath = path.join(__dirname, 'collections', `${collectionName}.json`);

      if (fs.existsSync(collectionPath)) {
        console.log(`Found collection file: ${collectionName}.json`);

        const guildSettings = serverSettings.get(interaction.guild.id) || {};
        guildSettings.collectionName = collectionName;
        serverSettings.set(interaction.guild.id, guildSettings);

        await interaction.editReply({
          content: `Collection name set to ${collectionName} for verification.`,
        });
      } else {
        console.error(`Collection file ${collectionName}.json does not exist.`);
        await interaction.editReply({
          content: `Collection file ${collectionName}.json does not exist.`,
        });
      }
    }
  } catch (error) {
    console.error('Error handling interaction:', error);
    await interaction.editReply({
      content: 'There was an error while processing the command. Please check the logs for more details.',
    });
  }
});

// Function to check wallet inscriptions and update roles
async function checkWallets() {
  for (const [guildId, settings] of serverSettings) {
    const { roleID, collectionName, requiredCount } = settings;
    const guild = client.guilds.cache.get(guildId);
    const role = guild.roles.cache.get(roleID);

    const collectionPath = path.join(__dirname, 'collections', `${collectionName}.json`);
    if (!fs.existsSync(collectionPath)) {
      console.log(`Collection file not found: ${collectionName}.json`);
      continue;
    }

    const collectionData = JSON.parse(fs.readFileSync(collectionPath, 'utf-8'));
    const inscriptionList = collectionData.map((item) => item.inscriptionId);

    const users = await User.find();
    for (const user of users) {
      const holdsRequiredInscriptions = await checkForRequiredInscriptions(user.walletAddress, inscriptionList, requiredCount);

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

// Function to check for inscriptions using Maestro API
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
      const inscriptions = data.data.flatMap((utxo) => utxo.inscriptions.map(i => i.inscription_id) || []);
      allInscriptions.push(...inscriptions);
      cursor = data.next_cursor;
    } while (cursor);

    const matchingInscriptions = allInscriptions.filter(inscription => inscriptionList.includes(inscription));
    return matchingInscriptions.length >= requiredCount;
  } catch (error) {
    console.error('Error checking inscriptions:', error);
    return false;
  }
}

// Log in to Discord
client.login(process.env.DISCORD_BOT_TOKEN);
