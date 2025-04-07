import React, {useEffect, useRef, useState} from 'react';
import {
  SafeAreaView,
  StyleSheet,
  View,
  Text,
  TouchableOpacity,
  Alert,
  Platform,
} from 'react-native';
import Video from 'react-native-video';
import dgram from 'react-native-udp';
import {FFmpegKit, ReturnCode} from 'ffmpeg-kit-react-native';
import NetInfo from "@react-native-community/netinfo";

const TELLO_IP = '192.168.10.1';
const TELLO_PORT = 8889;
const LOCAL_VIDEO_PORT = 11111;
const LOCAL_OUTPUT_UDP_PORT = 11112;

const App = () => {
  const [isConnected, setIsConnected] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState('');
  const socket = useRef(null);
  const ffmpegSessionId = useRef(null);

  const checkNetwork = async () => {
    try {
      const state = await NetInfo.fetch();
      console.log("Connection type:", state.type);
      console.log("Is connected?", state.isConnected);
      console.log("WiFi details:", state.details);

      if (!state.isConnected) {
        setError("No network connection");
        return false;
      }

      if (state.type !== "wifi") {
        setError("Please connect to the Tello drone's WiFi network");
        return false;
      }

      // Optional: Check if connected to Tello's WiFi (SSID usually starts with TELLO-)
      if (Platform.OS === 'android' && state.details && state.details.ssid) {
        if (!state.details.ssid.startsWith('TELLO-')) {
          setError("Please connect to the Tello drone's WiFi network (TELLO-*)");
          return false;
        }
      }

      return true;
    } catch (error) {
      console.error("Error checking network:", error);
      setError("Failed to check network status: " + error.message);
      return false;
    }
  };

  const handleConnect = async () => {
    const hasPermission = await checkPermissions();
    if (!hasPermission) return;

    const isNetworkReady = await checkNetwork();
    if (!isNetworkReady) return;

    initializeDrone();
  };

  const initializeDrone = async () => {
    try {
      // Create UDP socket
      socket.current = dgram.createSocket('udp4');
      console.log('UDP socket created');
      
      // Set up error handler
      socket.current.on('error', (err) => {
        const errorMsg = `UDP Socket error: ${err.message}`;
        console.error(errorMsg);
        setError(errorMsg);
        Alert.alert('Connection Error', errorMsg);
      });

      // Set up message handler to see drone responses
      socket.current.on('message', (msg, rinfo) => {
        console.log(`Received response from drone: ${msg.toString()} from ${rinfo.address}:${rinfo.port}`);
      });

      // Bind to any available port
      await new Promise((resolve, reject) => {
        socket.current.bind(undefined, (err) => {
          if (err) {
            console.error('Socket bind error:', err);
            reject(err);
          } else {
            console.log('Socket bound successfully');
            resolve();
          }
        });
      });

      // Send initial commands
      const commands = ['command', 'streamon'];
      for (const cmd of commands) {
        console.log(`Sending command: ${cmd}`);
        await new Promise((resolve, reject) => {
          socket.current.send(cmd, 0, cmd.length, TELLO_PORT, TELLO_IP, (err) => {
            if (err) {
              console.error(`Failed to send command ${cmd}:`, err);
              reject(err);
            } else {
              console.log(`Command ${cmd} sent successfully`);
              resolve();
            }
          });
        });
        // Wait between commands
        await new Promise(resolve => setTimeout(resolve, 500));
      }

      setIsConnected(true);
      setError('');
      startFFmpeg();
    } catch (error) {
      const errorMsg = `Failed to initialize drone: ${error.message}`;
      console.error(errorMsg);
      setError(errorMsg);
      Alert.alert('Initialization Error', errorMsg);
      
      // Cleanup on error
      if (socket.current) {
        socket.current.close();
        socket.current = null;
      }
      setIsConnected(false);
    }
  };

  const startFFmpeg = async () => {
    // Modified command to handle H.264 stream properly
    const ffmpegCommand = `-f h264 -analyzeduration 2000000 -probesize 2000000 -fflags discardcorrupt -fflags nobuffer -flags low_delay -avioflags direct -i udp://0.0.0.0:${LOCAL_VIDEO_PORT} -c:v copy -muxdelay 0 -muxpreload 0 -f mpegts -listen 1 http://127.0.0.1:${LOCAL_OUTPUT_UDP_PORT}`;
    
    try {
      const session = await FFmpegKit.executeAsync(ffmpegCommand, 
        async (session) => {
          const returnCode = await session.getReturnCode();
          if (ReturnCode.isSuccess(returnCode)) {
            console.log('FFmpeg process completed successfully');
          } else {
            console.error('FFmpeg process failed with state:', await session.getState());
            const logs = await session.getLogs();
            console.error('FFmpeg logs:', logs);
            setError('FFmpeg process failed. Check logs for details.');
            setIsStreaming(false);
          }
        }
      );
      
      ffmpegSessionId.current = await session.getSessionId();
      
      // Give FFmpeg a moment to start up before attempting video playback
      await new Promise(resolve => setTimeout(resolve, 2000));
      setIsStreaming(true);
    } catch (error) {
      console.error('Failed to start FFmpeg:', error);
      Alert.alert('Error', 'Failed to start video stream');
      setIsStreaming(false);
    }
  };

  const cleanup = async () => {
    if (ffmpegSessionId.current) {
      await FFmpegKit.cancel(ffmpegSessionId.current);
      ffmpegSessionId.current = null;
    }
    if (socket.current) {
      socket.current.close();
      socket.current = null;
    }
    setIsConnected(false);
    setIsStreaming(false);
  };

  useEffect(() => {
    return () => {
      cleanup();
    };
  }, []);

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.content}>
        {error ? (
          <View style={styles.errorContainer}>
            <Text style={styles.errorText}>{error}</Text>
          </View>
        ) : null}
        {isStreaming ? (
          <Video
            source={{uri: `http://127.0.0.1:${LOCAL_OUTPUT_UDP_PORT}`}}
            style={styles.video}
            resizeMode="contain"
            repeat={true}
            onError={(error) => {
              console.error('Video playback error:', error);
              Alert.alert('Error', 'Video playback failed');
              setIsStreaming(false);
            }}
            onLoad={() => console.log('Video loaded successfully')}
            minBufferMs={500}
            maxBufferMs={1000}
            bufferForPlaybackMs={200}
            bufferForPlaybackAfterRebufferMs={500}
          />
        ) : (
          <View style={styles.placeholder}>
            <Text>No video stream</Text>
          </View>
        )}
        <TouchableOpacity
          style={[styles.button, isConnected && styles.buttonDisabled]}
          onPress={handleConnect}
          disabled={isConnected}>
          <Text style={styles.buttonText}>
            {isConnected ? 'Connected' : 'Connect to Drone'}
          </Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff',
  },
  content: {
    flex: 1,
    padding: 16,
  },
  video: {
    flex: 1,
    backgroundColor: '#000',
    marginBottom: 16,
  },
  placeholder: {
    flex: 1,
    backgroundColor: '#f0f0f0',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 16,
  },
  button: {
    backgroundColor: '#007AFF',
    padding: 16,
    borderRadius: 8,
    alignItems: 'center',
  },
  buttonDisabled: {
    backgroundColor: '#ccc',
  },
  buttonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: 'bold',
  },
  errorContainer: {
    backgroundColor: '#ffebee',
    padding: 10,
    marginBottom: 16,
    borderRadius: 4,
  },
  errorText: {
    color: '#c62828',
    fontSize: 14,
  },
});

export default App;