require('dotenv').config();
const { Client, GatewayIntentBits, SlashCommandBuilder, REST, Routes } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, VoiceConnectionStatus, entersState } = require('@discordjs/voice');
const { join } = require('path');
const { createReadStream, existsSync } = require('fs');

// Logging utility
const log = {
    info: (message) => console.log(`[${new Date().toISOString()}] INFO: ${message}`),
    error: (message, error) => console.error(`[${new Date().toISOString()}] ERROR: ${message}`, error ? `\n${error.stack}` : ''),
    debug: (message) => console.debug(`[${new Date().toISOString()}] DEBUG: ${message}`),
    warn: (message) => console.warn(`[${new Date().toISOString()}] WARN: ${message}`)
};

// Create a new client instance
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMessages
    ]
});

// Create an audio player
const player = createAudioPlayer();

// Store active connections
const activeConnections = new Map();

// Add error handling for the player
player.on('error', error => {
    log.error('Audio player error:', error);
});

// Log player state changes
player.on('stateChange', (oldState, newState) => {
    log.debug(`Player state changed: ${oldState.status} -> ${newState.status}`);
    if (newState.status === 'playing') {
        log.info('Audio is now playing');
    } else if (newState.status === 'idle') {
        log.info('Audio playback finished');
    }
});

// When the client is ready, run this code (only once)
client.once('ready', async () => {
    log.info('Bot is ready and connected to Discord!');
    log.info(`Bot is in ${client.guilds.cache.size} servers`);

    // Register slash commands
    const commands = [
        new SlashCommandBuilder()
            .setName('unrk')
            .setDescription('Control the Unrk bot')
            .addSubcommand(subcommand =>
                subcommand
                    .setName('stop')
                    .setDescription('Stop the bot and make it leave the voice channel')
            )
    ].map(command => command.toJSON());

    const rest = new REST().setToken(process.env.DISCORD_TOKEN);

    try {
        log.info('Started refreshing application (/) commands.');
        await rest.put(
            Routes.applicationCommands(client.user.id),
            { body: commands },
        );
        log.info('Successfully reloaded application (/) commands.');
    } catch (error) {
        log.error('Error refreshing application commands:', error);
    }
});

// Handle slash commands
client.on('interactionCreate', async interaction => {
    if (!interaction.isCommand()) return;

    if (interaction.commandName === 'unrk') {
        if (interaction.options.getSubcommand() === 'stop') {
            const guildId = interaction.guildId;
            const connection = activeConnections.get(guildId);

            if (connection) {
                connection.destroy();
                activeConnections.delete(guildId);
                await interaction.reply({ content: 'Bot has left the voice channel.', ephemeral: true });
                log.info(`Bot left voice channel in guild ${guildId} by command`);
            } else {
                await interaction.reply({ content: 'Bot is not in a voice channel.', ephemeral: true });
            }
        }
    }
});

// Listen for voice state updates
client.on('voiceStateUpdate', async (oldState, newState) => {
    const guildId = newState.guild.id;
    const connection = activeConnections.get(guildId);

    // Check if someone joined a voice channel
    if (!oldState.channelId && newState.channelId) {
        try {
            log.info(`User ${newState.member.user.tag} joined voice channel ${newState.channel.name}`);
            
            // Get the voice channel
            const channel = newState.channel;
            log.debug(`Attempting to join channel: ${channel.name} (${channel.id})`);
            
            // Create a voice connection
            const connection = joinVoiceChannel({
                channelId: channel.id,
                guildId: channel.guild.id,
                adapterCreator: channel.guild.voiceAdapterCreator,
            });

            // Store the connection
            activeConnections.set(guildId, connection);

            // Wait for the connection to be ready
            connection.on(VoiceConnectionStatus.Ready, async () => {
                log.info('Voice connection established successfully');
                
                try {
                    const filePath = join(__dirname, 'sounds/alpha.mp3');
                    log.debug(`Checking audio file at: ${filePath}`);
                    
                    // Verify the file exists
                    if (!existsSync(filePath)) {
                        throw new Error(`Audio file not found at ${filePath}`);
                    }
                    
                    log.debug('Audio file exists, creating resource...');
                    
                    // Create an audio resource from the MP3 file
                    const resource = createAudioResource(createReadStream(filePath), {
                        inlineVolume: true
                    });
                    
                    log.debug('Audio resource created successfully');
                    
                    // Set volume to maximum
                    resource.volume.setVolume(1.0);
                    log.debug('Volume set to maximum');
                    
                    // Add a small delay to ensure connection is fully established
                    await new Promise(resolve => setTimeout(resolve, 1000));
                    
                    // Subscribe the connection to the player first
                    connection.subscribe(player);
                    log.debug('Connection subscribed to player');
                    
                    // Then play the audio
                    player.play(resource);
                    log.info('Audio playback started');
                    
                    // Handle when the audio finishes playing
                    player.once('stateChange', (oldState, newState) => {
                        if (newState.status === 'idle') {
                            log.info('Audio finished playing, disconnecting...');
                            connection.destroy();
                            activeConnections.delete(guildId);
                        }
                    });
                    
                } catch (error) {
                    log.error('Error during audio playback setup:', error);
                    connection.destroy();
                    activeConnections.delete(guildId);
                }
            });

            // Handle connection errors
            connection.on('error', error => {
                log.error('Voice connection error:', error);
                activeConnections.delete(guildId);
            });

            // Handle disconnection
            connection.on(VoiceConnectionStatus.Disconnected, async () => {
                log.info('Voice connection disconnected, attempting to reconnect...');
                try {
                    await Promise.race([
                        entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
                        entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
                    ]);
                    log.info('Successfully reconnected to voice channel');
                } catch (error) {
                    log.warn('Failed to reconnect, destroying connection');
                    connection.destroy();
                    activeConnections.delete(guildId);
                }
            });

        } catch (error) {
            log.error('Error in voice state update handler:', error);
        }
    }

    // Check if someone left a voice channel
    if (oldState.channelId && !newState.channelId && connection) {
        const voiceChannel = oldState.channel;
        const members = voiceChannel.members.filter(member => !member.user.bot);
        
        if (members.size === 0) {
            log.info('Voice channel is empty, disconnecting...');
            connection.destroy();
            activeConnections.delete(guildId);
        }
    }
});

// Handle client errors
client.on('error', error => {
    log.error('Discord client error:', error);
});

// Handle process errors
process.on('unhandledRejection', error => {
    log.error('Unhandled promise rejection:', error);
});

process.on('uncaughtException', error => {
    log.error('Uncaught exception:', error);
});

// Login to Discord with your client's token
log.info('Attempting to login to Discord...');
client.login(process.env.DISCORD_TOKEN)
    .then(() => log.info('Successfully logged in to Discord'))
    .catch(error => log.error('Failed to login to Discord:', error));
