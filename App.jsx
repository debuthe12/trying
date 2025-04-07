import React, { useEffect, useRef, useState, useCallback } from 'react';
import {
  SafeAreaView,
  StyleSheet,
  View,
  Text,
  TouchableOpacity,
  Alert,
  Platform,
  PermissionsAndroid, // Added for basic permission check example
} from 'react-native';
import Video from 'react-native-video';
import dgram from 'react-native-udp';
import { FFmpegKit, ReturnCode, FFmpegKitConfig } from 'ffmpeg-kit-react-native';
import NetInfo from "@react-native-community/netinfo";

// --- Constants ---
const TELLO_IP = '192.168.10.1';
const TELLO_COMMAND_PORT = 8889; // Tello listens for commands here
const TELLO_STATE_PORT = 8890; // Tello sends state updates here (optional to listen)
const TELLO_VIDEO_PORT = 11111; // Tello sends video stream here

const LOCAL_COMMAND_PORT_BIND = 9000; // Port for our app to send commands FROM and receive responses TO
const LOCAL_VIDEO_INPUT_PORT = TELLO_VIDEO_PORT; // Port FFmpeg listens on for Tello's video
const LOCAL_VIDEO_OUTPUT_HTTP_PORT = 11112; // Port FFmpeg serves the processed stream via HTTP

// --- Enum for Connection Status ---
const ConnectionStatus = {
  DISCONNECTED: 'DISCONNECTED',
  CONNECTING: 'CONNECTING',
  CONNECTED: 'CONNECTED',
  STREAMING: 'STREAMING',
  ERROR: 'ERROR',
};

const App = () => {
  const [status, setStatus] = useState(ConnectionStatus.DISCONNECTED);
  const [error, setError] = useState('');
  const commandSocket = useRef(null); // Renamed for clarity
  const ffmpegSessionId = useRef(null);
  const videoPlayerRef = useRef(null); // Ref for Video component

  // --- Cleanup Function ---
  const cleanup = useCallback(async () => {
    console.log('Cleaning up resources...');
    setStatus(ConnectionStatus.DISCONNECTED);
    setError(''); // Clear error on cleanup

    // Cancel FFmpeg session
    if (ffmpegSessionId.current) {
      try {
        console.log('Cancelling FFmpeg session:', ffmpegSessionId.current);
        await FFmpegKit.cancel(ffmpegSessionId.current);
      } catch (e) {
        console.error("Error cancelling FFmpeg session:", e);
      } finally {
        ffmpegSessionId.current = null;
      }
    }

    // Close UDP socket
    if (commandSocket.current) {
      try {
        console.log('Closing UDP socket');
        commandSocket.current.close();
      } catch(e) {
         console.error("Error closing socket:", e);
      } finally {
        commandSocket.current = null;
      }
    }
  }, []); // Empty dependency array means this function is stable

  // --- Effect for Unmounting ---
  useEffect(() => {
    // Enable FFmpegKit logs (optional but helpful for debugging)
    FFmpegKitConfig.enableLogCallback(log => console.log(`FFmpegKit Log: ${log.getMessage()}`));
    FFmpegKitConfig.enableStatisticsCallback(stats => console.log(`FFmpegKit Stats: ${JSON.stringify(stats)}`));

    return () => {
      cleanup(); // Cleanup on component unmount
    };
  }, [cleanup]); // Depend on cleanup function

  // --- Permission Handling (Basic Example) ---
  const checkPermissions = async () => {
    if (Platform.OS === 'android') {
      try {
        const granted = await PermissionsAndroid.request(
          PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
          {
            title: "Location Permission Needed for WiFi",
            message: "This app needs location access to scan for and connect to the Tello WiFi network.",
            buttonNeutral: "Ask Me Later",
            buttonNegative: "Cancel",
            buttonPositive: "OK"
          }
        );
        if (granted !== PermissionsAndroid.RESULTS.GRANTED) {
          setError("Location permission denied. Cannot scan for WiFi.");
          setStatus(ConnectionStatus.ERROR);
          return false;
        }
        return true;
      } catch (err) {
        console.warn(err);
        setError("Error requesting location permission.");
        setStatus(ConnectionStatus.ERROR);
        return false;
      }
    }
    // iOS permissions for network might be needed differently (e.g., local network usage description in Info.plist)
    return true; // Assume granted or not needed for other platforms for this example
  };

  // --- Network Check ---
  const checkNetwork = async () => {
    setError(''); // Clear previous network errors
    try {
      const state = await NetInfo.fetch();
      console.log("Connection type:", state.type);
      console.log("Is connected?", state.isConnected);
      // console.log("WiFi details:", state.details); // Can be verbose

      if (!state.isConnected) {
        setError("No network connection.");
        setStatus(ConnectionStatus.ERROR);
        return false;
      }

      if (state.type !== "wifi") {
        setError("Please connect to a WiFi network.");
        setStatus(ConnectionStatus.ERROR);
        return false;
      }

      // More specific Tello check (optional but recommended)
      if (Platform.OS === 'android' && state.details?.ssid) {
         if (!state.details.ssid.startsWith('TELLO-')) {
            setError(`Connected to "${state.details.ssid}". Please connect to the Tello drone's WiFi network (starts with TELLO-).`);
            setStatus(ConnectionStatus.ERROR);
            return false;
         }
      } else if (Platform.OS === 'ios') {
         // iOS often doesn't provide SSID easily due to privacy.
         // You might just have to rely on the user connecting to the right network.
         // Or check if the gateway IP matches TELLO_IP? More complex.
         console.log("iOS WiFi check: Assuming user connected to Tello network.");
      }


      console.log("Network check passed.");
      return true;
    } catch (error) {
      console.error("Error checking network:", error);
      setError("Failed to check network status: " + error.message);
      setStatus(ConnectionStatus.ERROR);
      return false;
    }
  };

  // --- Send Command to Drone ---
  const sendCommand = (command) => {
    return new Promise((resolve, reject) => {
      if (!commandSocket.current) {
        return reject(new Error("Socket not initialized"));
      }
      console.log(`Sending command: ${command}`);
      commandSocket.current.send(command, 0, command.length, TELLO_COMMAND_PORT, TELLO_IP, (err) => {
        if (err) {
          console.error(`Failed to send command ${command}:`, err);
          reject(err);
        } else {
          console.log(`Command ${command} sent successfully`);
          // Basic implementation: resolve after sending.
          // TODO: Implement response listener with timeout for robust command confirmation ('ok')
          resolve();
        }
      });
    });
  };

  // --- Initialize Drone Connection ---
  const initializeDrone = async () => {
    setStatus(ConnectionStatus.CONNECTING);
    setError('');

    try {
      // --- 1. Create and Bind UDP Socket ---
      console.log('Creating UDP command socket...');
      commandSocket.current = dgram.createSocket({ type: 'udp4', debug: true }); // Enable debug logs for react-native-udp

      // Setup error handler *before* binding
       commandSocket.current.on('error', (err) => {
        const errorMsg = `UDP Socket error: ${err.message}`;
        console.error(errorMsg, err);
        setError(errorMsg);
        setStatus(ConnectionStatus.ERROR);
        cleanup(); // Clean up on socket error
      });

      // Setup message handler (essential for robust commands)
      commandSocket.current.on('message', (msg, rinfo) => {
        console.log(`Drone response: ${msg.toString()} from ${rinfo.address}:${rinfo.port}`);
        // TODO: Add logic here to match responses ('ok', 'error', state data) to sent commands or update state
      });

      await new Promise((resolve, reject) => {
        commandSocket.current.bind(LOCAL_COMMAND_PORT_BIND, (err) => { // Bind to a specific local port
          if (err) {
            console.error('Socket bind error:', err);
            reject(new Error(`Failed to bind socket to port ${LOCAL_COMMAND_PORT_BIND}: ${err.message}`));
          } else {
            console.log(`Socket bound successfully to port ${LOCAL_COMMAND_PORT_BIND}`);
            resolve();
          }
        });
      });

      // --- 2. Send Initial Commands ---
      await sendCommand('command'); // Enter SDK mode
      await new Promise(resolve => setTimeout(resolve, 500)); // Wait briefly

      await sendCommand('streamon'); // Request video stream
      await new Promise(resolve => setTimeout(resolve, 500)); // Wait again (ideally wait for 'ok')

      setStatus(ConnectionStatus.CONNECTED); // Mark as connected after commands sent
      console.log("Drone initialized, attempting to start stream processing...");

      // --- 3. Start FFmpeg ---
      startFFmpeg();

    } catch (error) {
      const errorMsg = `Failed to initialize drone: ${error.message}`;
      console.error(errorMsg, error);
      setError(errorMsg);
      setStatus(ConnectionStatus.ERROR);
      await cleanup(); // Ensure cleanup happens on initialization failure
    }
  };

  // --- Start FFmpeg Process ---
  const startFFmpeg = async () => {
    // Input: Listen on UDP port where Tello sends video
    // Output: Serve via HTTP on localhost
    // Flags adjusted slightly for clarity/common use, tuning might still be needed.
    const ffmpegCommand = `-f h264 -analyzeduration 2000000 -probesize 2000000 -fflags discardcorrupt -fflags nobuffer -flags low_delay -avioflags direct -i udp://0.0.0.0:${LOCAL_VIDEO_INPUT_PORT} -c:v copy -muxdelay 0 -muxpreload 0 -f mpegts -listen 1 http://127.0.0.1:${LOCAL_VIDEO_OUTPUT_HTTP_PORT}`;;
                        

    console.log("Starting FFmpeg with command:", ffmpegCommand);

    try {
      // Execute asynchronously
      const session = await FFmpegKit.executeAsync(ffmpegCommand,
        async (completedSession) => {
            // This callback runs when the session FINISHES (normally or abnormally)
            const returnCode = await completedSession.getReturnCode();
            const sessionId = completedSession.getSessionId();
            console.log(`FFmpeg session ${sessionId} completed.`);

            if (ReturnCode.isSuccess(returnCode)) {
                console.log('FFmpeg process completed successfully.');
                 // If it completes successfully while streaming was active, it might mean the stream stopped
                 if (status === ConnectionStatus.STREAMING) {
                    console.warn("FFmpeg exited successfully while streaming, stream might have stopped.");
                    // Decide if this is an error or expected disconnection
                    // setError("Video stream stopped.");
                    // setStatus(ConnectionStatus.CONNECTED); // Go back to connected, maybe?
                 }
            } else if (ReturnCode.isCancel(returnCode)) {
                console.log('FFmpeg process cancelled.');
                // This is expected during cleanup
            } else {
                console.error('FFmpeg process failed.');
                const logs = await completedSession.getLogsAsString();
                console.error('FFmpeg logs:\n', logs);
                setError('FFmpeg processing error. Check logs.');
                setStatus(ConnectionStatus.ERROR);
                // No need to call cleanup here, it should happen via button or unmount
            }
            // Ensure session ID is cleared if this specific session ended
            if (ffmpegSessionId.current === sessionId) {
                ffmpegSessionId.current = null;
            }
        }
        // Log callback (already enabled via FFmpegKitConfig)
        // Statistics callback (already enabled via FFmpegKitConfig)
      );

      ffmpegSessionId.current = await session.getSessionId();
      console.log('FFmpeg session started with ID:', ffmpegSessionId.current);

      // Don't immediately set to Streaming. Wait for Video component's onLoad.
      // setStatus(ConnectionStatus.STREAMING); // <- REMOVED THIS GUESS
      console.log("FFmpeg initiated. Waiting for video player to load stream...");

    } catch (error) {
      console.error('Failed to execute FFmpeg command:', error);
      setError(`Failed to start FFmpeg: ${error.message}`);
      setStatus(ConnectionStatus.ERROR);
      await cleanup();
    }
  };

  // --- Button Handler ---
  const handleConnectPress = async () => {
    // Prevent multiple connection attempts
    if (status === ConnectionStatus.CONNECTING || status === ConnectionStatus.CONNECTED || status === ConnectionStatus.STREAMING) {
      console.log("Already connected or connecting.");
      return;
    }

    setError(''); // Clear previous errors
    setStatus(ConnectionStatus.CONNECTING); // Indicate attempt

    const permissionsGranted = await checkPermissions();
    if (!permissionsGranted) return; // Error state already set in checkPermissions

    const networkReady = await checkNetwork();
    if (!networkReady) return; // Error state already set in checkNetwork

    // If checks pass, initialize
    initializeDrone();
  };

  // --- Button Handler for Disconnect ---
  const handleDisconnectPress = () => {
    console.log("Disconnect button pressed.");
    cleanup(); // Trigger manual cleanup
  }

  // --- Video Player Callbacks ---
  const onVideoLoad = () => {
    console.log('Video stream loaded successfully!');
    if (status !== ConnectionStatus.STREAMING) {
      setStatus(ConnectionStatus.STREAMING); // Set streaming status only when video confirms load
      setError(''); // Clear any lingering non-critical errors
    }
  };

  const onVideoError = (err) => {
    console.error('Video playback error:', err);
    setError(`Video playback error: ${err.error?.localizedFailureReason || err.error?.localizedDescription || 'Unknown video error'}`);
    // Don't set status to ERROR here, as FFmpeg might still be running.
    // Let FFmpeg failure callback handle critical errors.
    // Could potentially try to restart FFmpeg or just show the error.
     setStatus(ConnectionStatus.CONNECTED); // Revert status to connected, as stream failed
  };

  // --- Render Logic ---
  const renderContent = () => {
    switch (status) {
      case ConnectionStatus.STREAMING:
      case ConnectionStatus.CONNECTED: // Show video placeholder even if connected but not streaming yet
      case ConnectionStatus.CONNECTING: // Show placeholder during connection attempt
        return (
          <Video
            ref={videoPlayerRef}
            source={{ uri: `http://127.0.0.1:${LOCAL_VIDEO_OUTPUT_HTTP_PORT}` }}
            style={styles.video}
            resizeMode="contain"
            repeat={true}
            onError={onVideoError}
            onLoad={onVideoLoad} // Use onLoad to confirm stream readiness
            // Buffer settings might need tuning
            minBufferMs={200}   // Try smaller buffers for lower latency
            maxBufferMs={500}
            bufferForPlaybackMs={100}
            bufferForPlaybackAfterRebufferMs={200}
            controls={false} // Hide default controls
            paused={status !== ConnectionStatus.STREAMING} // Pause if not actively streaming
          />
        );
      default:
        // DISCONNECTED or ERROR states
        return (
          <View style={styles.placeholder}>
            <Text>{status === ConnectionStatus.ERROR ? 'Error State' : 'Disconnected'}</Text>
          </View>
        );
    }
  };

  const getButtonText = () => {
    switch (status) {
      case ConnectionStatus.CONNECTING: return 'Connecting...';
      case ConnectionStatus.CONNECTED: return 'Connected (No Stream)';
      case ConnectionStatus.STREAMING: return 'Streaming...';
      case ConnectionStatus.DISCONNECTED: return 'Connect to Drone';
      case ConnectionStatus.ERROR: return 'Connect to Drone'; // Allow retry after error
      default: return 'Connect';
    }
  };

  const isConnectButtonDisabled = status === ConnectionStatus.CONNECTING || status === ConnectionStatus.CONNECTED || status === ConnectionStatus.STREAMING;

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.content}>
        {/* Status/Error Display */}
        {error ? (
          <View style={styles.errorContainer}>
            <Text style={styles.errorText}>{error}</Text>
          </View>
        ) : (
           <View style={styles.statusContainer}>
             <Text style={styles.statusText}>Status: {status}</Text>
           </View>
        )}

        {/* Video or Placeholder */}
        <View style={styles.videoContainer}>
          {renderContent()}
        </View>

        {/* Control Buttons */}
        <View style={styles.buttonContainer}>
            <TouchableOpacity
              style={[styles.button, isConnectButtonDisabled && styles.buttonDisabled]}
              onPress={handleConnectPress}
              disabled={isConnectButtonDisabled}>
              <Text style={styles.buttonText}>{getButtonText()}</Text>
            </TouchableOpacity>

           { (status === ConnectionStatus.CONNECTED || status === ConnectionStatus.STREAMING || status === ConnectionStatus.CONNECTING ) &&
              <TouchableOpacity
                style={[styles.button, styles.disconnectButton]}
                onPress={handleDisconnectPress} >
                <Text style={styles.buttonText}>Disconnect</Text>
              </TouchableOpacity>
           }
        </View>
      </View>
    </SafeAreaView>
  );
};

// --- Styles (Adjusted for new layout) ---
const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f5f5f5', // Lighter background
  },
  content: {
    flex: 1,
    padding: 16,
    justifyContent: 'space-between', // Push controls to bottom
  },
  statusContainer: {
     backgroundColor: '#e0e0e0',
     padding: 8,
     borderRadius: 4,
     marginBottom: 8,
     alignItems: 'center',
  },
  statusText: {
     fontSize: 14,
     color: '#333',
  },
  errorContainer: {
    backgroundColor: '#ffebee',
    padding: 10,
    marginBottom: 8,
    borderRadius: 4,
  },
  errorText: {
    color: '#c62828',
    fontSize: 14,
    textAlign: 'center',
  },
  videoContainer: {
    flex: 1, // Take up available space
    backgroundColor: '#000', // Background for the container area
    marginBottom: 16,
    justifyContent: 'center',
    alignItems: 'center',
  },
  video: {
    width: '100%', // Ensure video tries to fill container width
    height: '100%', // Ensure video tries to fill container height
  },
  placeholder: {
    flex: 1, // Take up same space as video would
    width: '100%',
    backgroundColor: '#e0e0e0',
    justifyContent: 'center',
    alignItems: 'center',
  },
  buttonContainer: {
    // Styles for the container holding the buttons if needed
    // e.g., flexDirection: 'row', justifyContent: 'space-around'
  },
  button: {
    backgroundColor: '#007AFF',
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 8,
    alignItems: 'center',
    marginBottom: 10, // Space between buttons
  },
  buttonDisabled: {
    backgroundColor: '#ccc',
  },
  disconnectButton: {
      backgroundColor: '#d9534f', // Red color for disconnect/stop
  },
  buttonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: 'bold',
  },
});

export default App;