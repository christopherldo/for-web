import {
  Accessor,
  batch,
  createContext,
  createEffect,
  createSignal,
  JSX,
  Setter,
  useContext,
} from "solid-js";
import {
  RoomContext,
  TrackReferenceOrPlaceholder,
  useTracks,
} from "solid-livekit-components";

import {
  LocalTrackPublication,
  LocalVideoTrack,
  Room,
  RoomEvent,
  ScreenShareCaptureOptions,
  ScreenSharePresets,
  Track,
  VideoEncoding,
  VideoPreset,
  VideoPresets,
} from "livekit-client";
import { Channel } from "stoat.js";

/** LiveKit attribute: local user is watching this streamer's screen share. */
const WATCH_ATTR_PREFIX = "soarapa.watch.";

/** Custom screen-share presets — LiveKit defaults are too soft for desktop UI
 * (e.g. h720fps30 ≈ 2 Mbps). Bitrate closer to Discord “Better quality”. */
const ScreenShare720p30 = new VideoPreset(1280, 720, 4_500_000, 30, "medium");
const ScreenShare720p60 = new VideoPreset(1280, 720, 6_000_000, 60, "medium");
const ScreenShare1080p30 = new VideoPreset(1920, 1080, 8_000_000, 30, "medium");
const ScreenShare1080p60 = new VideoPreset(
  1920,
  1080,
  10_000_000,
  60,
  "medium",
);
const ScreenShareSource = new VideoPreset(0, 0, 8_000_000, 5, "medium");

import { SoundController, useSound } from "@revolt/client";
import { useInstance } from "@revolt/instance";
import { ModalController, useModals } from "@revolt/modal";
import { useState } from "@revolt/state";
import {
  NoiseSuppresionState,
  ScreenShareQualityName,
  Voice as VoiceSettings,
} from "@revolt/state/stores/Voice";
import { VoiceCallCardContext } from "@revolt/ui/components/features/voice/callCard/VoiceCallCard";

import { Device, useDevice } from "@revolt/common";
import { InRoom } from "./components/InRoom";
import { RoomAudioManager } from "./components/RoomAudioManager";
import { BitrateGovernor, captureOptionsFor, planFor } from "./streamQuality";
import { VoiceProcessor } from "./VoiceProcessor";

type State =
  | "READY"
  | "DISCONNECTED"
  | "CONNECTING"
  | "CONNECTED"
  | "RECONNECTING";

export type VoiceLayout = "fullscreen" | "expanded" | "collapsed" | undefined;

type ScreenShareQuality = Required<
  Pick<ScreenShareCaptureOptions, "contentHint" | "resolution">
> & {
  name: ScreenShareQualityName;
  fullName: string;
  encoding: VideoEncoding;
};

/**
 * Escrita recusada porque o writer já fechou — ou seja, a publicação terminou.
 *
 * Existe para separar isto de uma falha ao CONSTRUIR o VideoFrame. Os dois
 * chegavam no mesmo catch, e "Stream closed" no fim normal de uma transmissão
 * era lido como "NV12 recusado", reiniciando a captura de um stream morto.
 */
class WriterClosedError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "WriterClosedError";
  }
}

class Voice {
  #settings: VoiceSettings;

  channel: Accessor<Channel | undefined>;
  #setChannel: Setter<Channel | undefined>;

  room: Accessor<Room | undefined>;
  #setRoom: Setter<Room | undefined>;

  vidTracks: Accessor<TrackReferenceOrPlaceholder[]>;

  state: Accessor<State>;
  #setState: Setter<State>;

  deafen: Accessor<boolean>;
  microphone: Accessor<boolean>;

  video: Accessor<boolean>;
  #setVideo: Setter<boolean>;

  screenshare: Accessor<boolean>;
  #setScreenshare: Setter<boolean>;

  layout: Accessor<VoiceLayout>;
  #setLayout: Setter<VoiceLayout>;

  focusId: Accessor<string | undefined>;
  #setFocus: Setter<string | undefined>;

  showBar: Accessor<boolean>;
  #setShowBar: Setter<boolean>;

  /** Bumps when any participant attributes change (drives viewer-count UI). */
  watchPresence: Accessor<number>;
  #setWatchPresence: Setter<number>;

  private sound: SoundController;
  private device: Device;

  private openModal;
  private config;
  private limits;
  private screenShareTracks: Set<string>;
  private voiceProcessor?: VoiceProcessor;
  private appShareCleanup?: () => void;
  private recoveringAppShare = false;
  /** Canvas bridge: published track never dies when OS capture window switches. */
  private appShareBridge = false;
  private appShareVideo?: HTMLVideoElement;
  private appShareCanvas?: HTMLCanvasElement;
  private appShareDrawHandle = 0;
  private appShareInputStream?: MediaStream;
  private appSharePublication?: LocalTrackPublication;
  private appShareLastDraw = 0;
  /** Native WGC path (desktop Windows) — bypasses Chromium getDisplayMedia. */
  private nativeWgcCleanup?: () => void;
  private nativeWgcPublication?: LocalTrackPublication;
  private nativeWgcWriter?: WritableStreamDefaultWriter<VideoFrame>;
  private nativeWgcAudioTrack?: MediaStreamTrack;
  private nativeWgcAudioCleanup?: () => void;

  constructor(
    voiceSettings: VoiceSettings,
    modals: ModalController,
    sound: SoundController,
    device: Device,
  ) {
    this.#settings = voiceSettings;
    this.sound = sound;
    this.device = device;

    const [channel, setChannel] = createSignal<Channel>();
    this.channel = channel;
    this.#setChannel = setChannel;

    const [room, setRoom] = createSignal<Room>();
    this.room = room;
    this.#setRoom = setRoom;

    this.vidTracks = () => [];

    const [state, setState] = createSignal<State>("READY");
    this.state = state;
    this.#setState = setState;

    this.deafen = () => voiceSettings.deafen;
    this.microphone = () => voiceSettings.micOn && !voiceSettings.deafen;

    const [video, setVideo] = createSignal(false);
    this.video = video;
    this.#setVideo = setVideo;

    const [screenshare, setScreenshare] = createSignal(false);
    this.screenshare = screenshare;
    this.#setScreenshare = setScreenshare;

    const [layout, setLayout] = createSignal<VoiceLayout>();
    this.layout = layout;
    this.#setLayout = setLayout;

    const [focus, setFocus] = createSignal<string>();
    this.focusId = focus;
    this.#setFocus = setFocus;

    const [showBar, setShowBar] = createSignal(true);
    this.showBar = showBar;
    this.#setShowBar = setShowBar;

    const [watchPresence, setWatchPresence] = createSignal(0);
    this.watchPresence = watchPresence;
    this.#setWatchPresence = setWatchPresence;

    const inst = useInstance();
    this.config = inst.config;
    this.limits = inst.limits;
    this.openModal = modals.openModal;

    this.screenShareTracks = new Set();

    // Setup settings listeners
    this.settingsListeners();
  }

  // Dynamically set echo cancellation and gain control when the settings are changed
  // These functions are needed to maintain reactivity. Don't ask me why but if you make them not functions it breaks.
  private settingsListeners() {
    const getSettings = () => this.#settings;

    const setEchoCancellation = (echoCancellation: boolean) => {
      const track = this.getMicrophoneTrack()?.audioTrack;
      if (track) {
        track.constraints.echoCancellation = echoCancellation;
      }
    };

    const setAutoGainControl = (autoGainControl: boolean) => {
      const track = this.getMicrophoneTrack()?.audioTrack;
      if (track) {
        track.constraints.autoGainControl = autoGainControl;
      }
    };

    const setNoiseSuppression = (noiseSuppression: NoiseSuppresionState) => {
      const track = this.getMicrophoneTrack()?.audioTrack;
      if (track) {
        if (noiseSuppression === "browser") {
          track.constraints.noiseSuppression = true;
          //@ts-expect-error voiceIsolation is not yet standard, but it supported by livekit and most chromium based browsers, including electron.
          track.constraints.voiceIsolation = true;
        } else {
          track.constraints.noiseSuppression = false;
          //@ts-expect-error voiceIsolation is not yet standard, but it supported by livekit and most chromium based browsers, including electron.
          track.constraints.voiceIsolation = false;
        }
      }
    };

    const restartTrack = () => {
      const track = this.getMicrophoneTrack()?.audioTrack;
      if (track) {
        track.restartTrack();
      }
    };

    createEffect(() => {
      setEchoCancellation(getSettings().echoCancellation ?? true);
      setAutoGainControl(getSettings().autoGainControl ?? true);
      setNoiseSuppression(getSettings().noiseSupression ?? "browser");
      restartTrack();
    });
  }

  async connect(channel: Channel, auth?: { url: string; token: string }) {
    this.disconnect();

    this.device.setWakeLocked();

    const room = new Room({
      audioCaptureDefaults: {
        deviceId: this.#settings.preferredAudioInputDevice,
        echoCancellation: this.#settings.echoCancellation,
        noiseSuppression: this.#settings.noiseSupression === "browser",
        autoGainControl: this.#settings.autoGainControl,
        voiceIsolation: this.#settings.noiseSupression === "browser",
      },
      audioOutput: {
        deviceId: this.#settings.preferredAudioOutputDevice,
      },
      videoCaptureDefaults: {
        // TODO: Support higher resolutions based on limits
        resolution: VideoPresets.h720.resolution,
        deviceId: this.#settings.preferredVideoDevice,
      },
      publishDefaults: {
        videoEncoding: VideoPresets.h720.encoding,
        // Prefer H264 so Windows can use GPU encode (AMD/NVIDIA/Intel) instead of
        // soft VP8 — critical on weak CPUs (e.g. Ivy Bridge + RX 550).
        videoCodec: "h264",
        backupCodec: true,
        // Keep resolution when bandwidth dips — dropping res is what looks "tudo borrado".
        degradationPreference: "maintain-resolution",
        // One layer: put all bitrate into the stream people actually watch.
        simulcast: false,
        screenShareEncoding: ScreenShare720p30.encoding,
        screenShareSimulcastLayers: [],
      },
    });

    this.vidTracks = useTracks(
      [
        { source: Track.Source.Camera, withPlaceholder: true },
        { source: Track.Source.ScreenShare, withPlaceholder: false },
      ],
      { room, onlySubscribed: false },
    );

    batch(() => {
      this.#setRoom(room);
      this.#setChannel(channel);
      this.#setState("CONNECTING");
      this.#setVideo(false);
      this.#setScreenshare(false);
    });

    room.addListener("connected", () => {
      this.#setState("CONNECTED");
      if (this.speakingPermission)
        room.localParticipant
          .setMicrophoneEnabled(this.#settings.micOn)
          .then((track) => {
            this.#settings.micOn = track != null;
          });
      for (const p of room.remoteParticipants.values()) {
        const screenShareTrack = p.getTrackPublication(
          Track.Source.ScreenShare,
        );
        if (screenShareTrack) {
          this.screenShareTracks.add(screenShareTrack.trackSid);
        }
      }
      void this.syncWatchingAttributes();
      this.sound.playSound("userJoinVoice");
    });

    room.addListener("disconnected", () => this.#setState("DISCONNECTED"));

    room.addListener(RoomEvent.ParticipantAttributesChanged, () => {
      this.#setWatchPresence((n) => n + 1);
    });

    room.addListener("localTrackPublished", (pub) => {
      if (pub.audioTrack && pub.audioTrack.source === Track.Source.Microphone) {
        if (!pub.audioTrack.getProcessor()) {
          pub.audioTrack?.setProcessor(
            (this.voiceProcessor = new VoiceProcessor(this.#settings)),
          );
        }
      }
    });

    room.addListener("participantConnected", () => {
      this.sound.playSound("userJoinVoice");
    });

    room.addListener("participantDisconnected", () => {
      this.sound.playSound("userLeaveVoice");
      this.#setWatchPresence((n) => n + 1);
    });

    room.addListener("trackPublished", (pub, participant) => {
      if (pub.source === Track.Source.ScreenShare) {
        // Default is watching — publish presence so the streamer gets a count.
        if (this.#settings.isWatchingScreenShare(participant.identity)) {
          void this.setWatching(participant.identity, true);
        }
        pub.once("subscribed", (track) => {
          // Play the sound once playback starts, which might be quite a bit after subscription
          // as it starts paused for the screen share settings modal.
          track.once("videoPlaybackStarted", () => {
            this.sound.playSound("streamStart");
            if (track.sid) {
              this.screenShareTracks.add(track.sid);
            }
          });
        });
      }
    });

    room.addListener("trackUnpublished", (unpub, participant) => {
      if (this.screenShareTracks.has(unpub.trackSid)) {
        this.sound.playSound("streamEnd");
        this.screenShareTracks.delete(unpub.trackSid);
      }
      if (unpub.source === Track.Source.ScreenShare) {
        // Clear watch attribute for a stream that ended.
        void this.setWatching(participant.identity, false, {
          skipLocalPreference: true,
        });
      }
    });

    // Gather latency
    const selected = await Promise.any(
      this.config.features.livekit.nodes.map(async (node) => {
        return fetch(node.public_url.replace("wss", "https")).then(() => {
          return node.name;
        });
      }),
    );

    if (!auth) {
      auth = await channel.joinCall(selected);
    }

    await room.connect(auth.url, auth.token, {
      autoSubscribe: false,
    });
  }

  disconnect() {
    this.device.releaseWakeLock();
    try {
      const room = this.room();
      if (!room) return;

      room.removeAllListeners();
      room.disconnect();

      batch(() => {
        this.#setState("READY");
        this.#setRoom();
        this.#setChannel();
        this.#setLayout();
        this.vidTracks = () => [];
      });

      this.screenShareTracks = new Set();
      this.#setWatchPresence(0);

      this.sound.playSound("userLeaveVoice");
    } catch (e) {
      this.onErr(e);
    }
  }

  private watchAttrKey(streamerId: string) {
    return `${WATCH_ATTR_PREFIX}${streamerId}`;
  }

  /**
   * Publish local watch preference to the room (LiveKit participant attributes)
   * so every client can show a viewer count per screen share.
   */
  async setWatching(
    streamerId: string,
    watching: boolean,
    opts?: { skipLocalPreference?: boolean },
  ) {
    if (!opts?.skipLocalPreference) {
      this.#settings.setWatchingScreenShare(streamerId, watching);
    }

    const room = this.room();
    if (!room) return;
    // Streamer isn't a viewer of their own share.
    if (room.localParticipant.identity === streamerId) return;

    try {
      await room.localParticipant.setAttributes({
        [this.watchAttrKey(streamerId)]: watching ? "1" : "",
      });
      this.#setWatchPresence((n) => n + 1);
    } catch (e) {
      console.warn("[rtc] failed to sync watch attribute", e);
    }
  }

  /** Re-publish watch attributes for every active remote screen share. */
  private async syncWatchingAttributes() {
    const room = this.room();
    if (!room) return;

    const attrs: Record<string, string> = {};
    for (const p of room.remoteParticipants.values()) {
      const hasShare = p.getTrackPublication(Track.Source.ScreenShare);
      if (!hasShare) continue;
      attrs[this.watchAttrKey(p.identity)] =
        this.#settings.isWatchingScreenShare(p.identity) ? "1" : "";
    }

    if (!Object.keys(attrs).length) return;
    try {
      await room.localParticipant.setAttributes(attrs);
      this.#setWatchPresence((n) => n + 1);
    } catch (e) {
      console.warn("[rtc] failed to sync watch attributes", e);
    }
  }

  /**
   * How many participants are currently watching this streamer's screen share.
   * The streamer themself is never counted.
   */
  screenShareViewerCount(streamerId: string): number {
    this.watchPresence();
    const room = this.room();
    if (!room) return 0;

    const key = this.watchAttrKey(streamerId);
    let count = 0;

    if (
      room.localParticipant.identity !== streamerId &&
      room.localParticipant.attributes[key] === "1"
    ) {
      count++;
    }

    for (const p of room.remoteParticipants.values()) {
      if (p.identity === streamerId) continue;
      if (p.attributes[key] === "1") count++;
    }

    return count;
  }

  async toggleDeafen(fromMute?: boolean) {
    try {
      const room = this.room();
      if (!room) throw "invalid state";
      await room.localParticipant.setMicrophoneEnabled(
        (this.#settings.micOn || !!fromMute) &&
          !room.localParticipant.isMicrophoneEnabled,
      );

      this.#settings.deafen = !this.#settings.deafen;
      if (fromMute) {
        this.#settings.micOn = room.localParticipant.isMicrophoneEnabled;
      }
      if (this.#settings.deafen) {
        this.sound.playSound("deafen");
      } else {
        this.sound.playSound("undeafen");
      }
    } catch (e) {
      this.onErr(e);
    }
  }

  async toggleMute() {
    if (this.#settings.deafen) {
      this.toggleDeafen(true);
      return;
    }
    try {
      const room = this.room();
      if (!room) throw "invalid state";
      await room.localParticipant.setMicrophoneEnabled(
        !room.localParticipant.isMicrophoneEnabled,
      );

      this.#settings.micOn = room.localParticipant.isMicrophoneEnabled;

      if (this.#settings.micOn) {
        this.sound.playSound("unmute");
      } else {
        this.sound.playSound("mute");
      }
    } catch (e) {
      this.onErr(e);
    }
  }

  async toggleCamera() {
    try {
      const room = this.room();
      if (!room) throw "invalid state";
      await room.localParticipant.setCameraEnabled(
        !room.localParticipant.isCameraEnabled,
      );

      this.#setVideo(room.localParticipant.isCameraEnabled);
    } catch (e) {
      this.onErr(e);
    }
  }

  /**
   * Get the enabled screen share qualities. "low" will always be enabled.
   * Each screen share quality is checked against the limit if the limit is available on the client.
   *
   * TODO: Translate the fullNames here, I can't figure out how to do it.
   *
   * @param name The name of the screen share quality to get
   * @returns A partial record of ScreenShareQualityName to ScreenShareQuality. Will always contain "low" quality.
   */
  getEnabledScreenShareQualities(): Partial<
    Record<ScreenShareQualityName, ScreenShareQuality>
  > {
    // Always enable 720p @ 30 and 60
    const qualities: Partial<
      Record<ScreenShareQualityName, ScreenShareQuality>
    > = {
      low: {
        name: "low",
        resolution: ScreenShare720p30.resolution,
        fullName: `720p 30FPS`,
        // detail = sharper text/UI than motion (Discord-like for desktop)
        contentHint: "detail",
        encoding: ScreenShare720p30.encoding,
      },
      low60: {
        name: "low60",
        resolution: ScreenShare720p60.resolution,
        fullName: `720p 60FPS`,
        contentHint: "motion",
        encoding: ScreenShare720p60.encoding,
      },
    };

    const limit = this.limits().video_resolution;

    // TODO: Add more resolutions to stream from if they're enabled. May tie into premium users in the future?
    if (
      (limit[0] === 0 || limit[0] >= 1920) &&
      (limit[1] === 0 || limit[1] >= 1080)
    ) {
      qualities.high = {
        name: "high",
        resolution: ScreenShare1080p30.resolution,
        fullName: `1080p 30FPS`,
        contentHint: "detail",
        encoding: ScreenShare1080p30.encoding,
      };
      qualities.high60 = {
        name: "high60",
        resolution: ScreenShare1080p60.resolution,
        fullName: `1080p 60FPS`,
        contentHint: "motion",
        encoding: ScreenShare1080p60.encoding,
      };

      const originalResolution = {
        ...ScreenSharePresets.original.resolution,
        frameRate: 5,
        aspectRatio: 0,
        width: limit[0],
        height: limit[1],
      };
      // If both resolutions are limited, set aspect ratio
      if (originalResolution.height !== 0 && originalResolution.width !== 0) {
        originalResolution.aspectRatio =
          originalResolution.width / originalResolution.height;
      }

      qualities.text = {
        name: "text",
        resolution: originalResolution,
        fullName: `Source 5FPS`,
        contentHint: "text",
        encoding: ScreenShareSource.encoding,
      };
    }

    return qualities;
  }

  async toggleScreenshare() {
    const room = this.room();
    if (!room) throw "invalid state";

    if (this.screenshare()) {
      if (this.nativeWgcPublication) {
        await this.stopNativeWgcShare();
        this.#setScreenshare(false);
        this.sound.playSound("streamEnd");
        return;
      }
      this.stopAppShareBridge();
      this.appShareCleanup?.();
      this.appShareCleanup = undefined;
      window.soarapaDesktop?.clearAppShare?.();

      await room.localParticipant.setScreenShareEnabled(false);

      this.#setScreenshare(room.localParticipant.isScreenShareEnabled);

      this.sound.playSound("streamEnd");
    } else {
      // Desktop + native WGC: window/app capture bypasses Chromium getDisplayMedia.
      if (await window.soarapaDesktop?.nativeWgcAvailable?.()) {
        try {
          const target = await window.soarapaDesktop.pickCaptureTarget?.();
          if (!target) return;
          if (target.kind === "screen") {
            window.soarapaDesktop.forceNextScreenSource?.(target.id);
            // fall through to normal setScreenShareEnabled below
          } else if (target.kind === "window" && target.hwnd) {
            const choice = await this.askScreenShareSettings(true);
            if (!choice) return;
            await this.startNativeWgcShare(
              target.hwnd,
              target.appId,
              choice.qualityName,
              choice.audio,
            );
            return;
          } else {
            return;
          }
        } catch (e) {
          this.onErr(e);
          return;
        }
      }

      const qualities = this.getEnabledScreenShareQualities();
      let screenPickerQualityName: ScreenShareQualityName | undefined;
      let screenPickerAudio: boolean | undefined;

      // Register the modal on screen picker handler if it exists
      if (window.native && window.native.onceScreenPicker) {
        window.native.onceScreenPicker((sources) => {
          this.openModal({
            type: "screen_share_picker",
            onCancel: () => {
              window.native.screenPickerCallback(-1, false);
            },
            callback: (
              idx: number,
              qualityName: ScreenShareQualityName,
              audio: boolean,
            ) => {
              window.native.screenPickerCallback(idx, audio);
              screenPickerQualityName = qualityName;
              screenPickerAudio = audio;
            },
            sources: sources,
            qualities: Object.keys(qualities).map((k) => {
              const v = qualities[k as ScreenShareQualityName]!;
              return { name: k, fullName: v.fullName };
            }),
          });
        });
      }

      try {
        const chosenQuality =
          this.getEnabledScreenShareQualities()[
            this.#settings.screenShareQuality || "low"
          ];
        const localTrack = await room.localParticipant.setScreenShareEnabled(
          true,
          {
            resolution: chosenQuality?.resolution,
            contentHint: chosenQuality?.contentHint ?? "detail",
            audio: {
              autoGainControl: false,
              echoCancellation: false,
              noiseSuppression: false,
              voiceIsolation: false,
              restrictOwnAudio: true,
            },
          },
          {
            screenShareEncoding: chosenQuality?.encoding,
            videoCodec: "h264",
            // Contrato regra 2 — o preset de texto é a exceção declarada.
            degradationPreference: planFor(
              this.#settings.screenShareQuality || "low",
            ).degradationPreference,
            simulcast: false,
          },
        );

        const screenAudioTrack = room.localParticipant.getTrackPublication(
          Track.Source.ScreenShareAudio,
        );

        this.#setScreenshare(room.localParticipant.isScreenShareEnabled);

        if (localTrack) {
          if (await window.soarapaDesktop?.shouldContinueAppShare?.()) {
            await this.startAppShareBridge(localTrack);
          }
          this.bindAppShareFollow(localTrack);

          const callback = async (
            qualityName: ScreenShareQualityName,
            audio: boolean,
          ) => {
            const quality = qualities[qualityName] || qualities.low!;

            if (localTrack.videoTrack) {
              await localTrack.videoTrack.applyScreenShareConstraints(
                {
                  resolution: {
                    frameRate: quality.resolution.frameRate,
                    width: quality.resolution.width,
                    height: quality.resolution.height,
                  },
                  contentHint: quality.contentHint,
                },
                quality.encoding,
              );
              if (!audio && screenAudioTrack?.track) {
                room.localParticipant.unpublishTrack(screenAudioTrack.track);
              }
              this.sound.playSound("streamStart");
            }
          };

          if (screenPickerQualityName) {
            callback(
              screenPickerQualityName || "low",
              screenPickerAudio || false,
            );
          } else if (this.#settings.screenShareQualityAsk) {
            if (Object.keys(qualities).length > 1) {
              localTrack.pauseUpstream();
              screenAudioTrack?.pauseUpstream();
              this.openModal({
                onCancel: async () => {
                  this.stopAppShareBridge();
                  await room.localParticipant.setScreenShareEnabled(false);
                  this.#setScreenshare(
                    room.localParticipant.isScreenShareEnabled,
                  );
                  this.appShareCleanup?.();
                  this.appShareCleanup = undefined;
                  window.soarapaDesktop?.clearAppShare?.();
                },
                type: "screen_share_settings",
                trackReference: {
                  participant: room.localParticipant,
                  publication: localTrack,
                  source: Track.Source.ScreenShare,
                },
                qualities: Object.keys(qualities).map((k) => {
                  const v = qualities[k as ScreenShareQualityName]!;
                  return { name: k, fullName: v.fullName };
                }),
                audio: !!screenAudioTrack,
                callback: async (qualityName, audio) => {
                  callback(qualityName, audio);
                  localTrack.resumeUpstream();
                  if (audio) {
                    screenAudioTrack?.resumeUpstream();
                  }
                },
              });
            } else {
              callback(
                this.#settings.screenShareQuality || "low",
                this.#settings.screenShareAudio,
              );
            }
          }
        }
      } catch (e) {
        this.onErr(e);
      }
    }
  }

  /**
   * Quality / audio prompt used by both Chromium and native WGC shares.
   * Resolves null if the user cancels.
   */
  private askScreenShareSettings(
    audioAvailable: boolean,
  ): Promise<{ qualityName: ScreenShareQualityName; audio: boolean } | null> {
    const qualities = this.getEnabledScreenShareQualities();
    const names = Object.keys(qualities) as ScreenShareQualityName[];

    if (!this.#settings.screenShareQualityAsk || names.length <= 1) {
      return Promise.resolve({
        qualityName: this.#settings.screenShareQuality || "low",
        audio: Boolean(audioAvailable && this.#settings.screenShareAudio),
      });
    }

    return new Promise((resolve) => {
      this.openModal({
        type: "screen_share_settings",
        qualities: names.map((k) => {
          const v = qualities[k]!;
          return { name: k, fullName: v.fullName };
        }),
        audio: audioAvailable,
        onCancel: () => resolve(null),
        callback: (qualityName, audio) => {
          resolve({ qualityName, audio });
        },
      });
    });
  }

  /**
   * Governa o bitrate da transmissão nativa em curso (contrato regra 3).
   * Vive enquanto a publicação viver; o retarget de janela não o reinicia.
   */
  private nativeWgcGovernor?: BitrateGovernor;

  /**
   * Native Windows Graphics Capture → LiveKit, with optional loopback audio.
   */
  private async startNativeWgcShare(
    hwnd: string,
    appId: string | null | undefined,
    qualityName: ScreenShareQualityName,
    wantAudio: boolean,
  ) {
    const room = this.room();
    if (!room) throw "invalid state";

    const Generator = (
      globalThis as unknown as {
        MediaStreamTrackGenerator?: new (init: {
          kind: "video";
        }) => MediaStreamTrack & {
          writable: WritableStream<VideoFrame>;
        };
      }
    ).MediaStreamTrackGenerator;

    if (!Generator || typeof VideoFrame === "undefined") {
      throw new Error("MediaStreamTrackGenerator/VideoFrame not supported");
    }

    await this.stopNativeWgcShare(false);

    const qualities = this.getEnabledScreenShareQualities();
    const quality = qualities[qualityName] || qualities.low!;
    // Plano inicial na base 16:9. O aspect real só se conhece no primeiro
    // frame, e é lá que o bitrate é recalculado (contrato regra 4).
    let plan = planFor(qualityName);

    const generator = new Generator({ kind: "video" });
    if ("contentHint" in generator) {
      // Perdido antes: o preset definia contentHint, mas quem era publicado era
      // este track, que nascia sem hint nenhum — e o encoder tratava partida de
      // LoL como slide parado.
      (generator as MediaStreamTrack).contentHint = plan.contentHint;
    }
    const writer = generator.writable.getWriter();
    this.nativeWgcWriter = writer;

    /**
     * Relógio real da captura. O contador fixo de 33_333µs que existia aqui
     * dizia "30fps" ao encoder independentemente do que chegava — o que tornava
     * os presets de 60fps decorativos.
     */
    const startedAt = performance.now();
    let lastTimestampUs = -1;

    /** Vira true se o VideoFrame recusar NV12 e a gente cair pra RGBA. */
    let nv12Rejected = false;

    /** 1 = ponte antiga (só maxWidth, sempre RGBA a 30fps). 2 = CaptureOptions. */
    const nativeApi = window.soarapaDesktop?.nativeCaptureApi ?? 1;

    /** Último tamanho entregue, para só replanejar quando ele muda. */
    let plannedW = 0;
    let plannedH = 0;

    /**
     * Last frame we pushed. While the desktop side is switching windows
     * (LoL client -> match) no frames arrive for a few seconds; we keep
     * re-sending this one so viewers see a frozen picture rather than a
     * stalled track.
     */
    let lastFrame: {
      data: Uint8Array;
      width: number;
      height: number;
      format: "nv12" | "rgba";
    } | null = null;
    let lastFrameAt = Date.now();

    const writeFrame = async (
      data: Uint8Array,
      width: number,
      height: number,
      format: "nv12" | "rgba",
    ) => {
      // Monotônico: dois frames no mesmo microssegundo fazem o encoder
      // descartar um deles em silêncio.
      const now = Math.round((performance.now() - startedAt) * 1000);
      const timestamp = now > lastTimestampUs ? now : lastTimestampUs + 1;
      lastTimestampUs = timestamp;

      const vf = new VideoFrame(data, {
        format: format === "nv12" ? "NV12" : "RGBA",
        codedWidth: width,
        codedHeight: height,
        timestamp,
        ...(format === "nv12"
          ? {
              colorSpace: {
                primaries: "bt709",
                transfer: "bt709",
                matrix: "bt709",
                fullRange: false,
              },
            }
          : {}),
      } as VideoFrameBufferInit);

      try {
        await this.nativeWgcWriter!.write(vf);
      } catch (e) {
        // Distinguir da falha de construção acima: escrever num writer fechado
        // é o fim normal da transmissão, não um problema de formato.
        throw new WriterClosedError(String(e));
      } finally {
        // Sem isto, todo frame que falha ao escrever vaza.
        vf.close();
      }
    };

    const unsubFrame = window.soarapaDesktop!.onNativeFrame!((frame) => {
      void (async () => {
        if (!this.nativeWgcWriter) return;
        // Só NV12 quando o nativo declara NV12. Binário antigo não manda
        // `format` nenhum e entrega RGBA — assumir NV12 ali viraria imagem
        // podre em vez de erro.
        const format = frame.format === "nv12" ? "nv12" : "rgba";
        try {
          // Sem cópia: o Electron entrega um buffer novo por mensagem e nada
          // mais escreve nele depois daqui. A cópia que existia neste ponto era
          // a quarta do mesmo frame no caminho.
          const bytes =
            frame.data instanceof ArrayBuffer
              ? new Uint8Array(frame.data)
              : new Uint8Array(
                  (frame.data as Uint8Array).buffer,
                  (frame.data as Uint8Array).byteOffset,
                  (frame.data as Uint8Array).byteLength,
                );
          lastFrame = {
            data: bytes,
            width: frame.width,
            height: frame.height,
            format,
          };
          lastFrameAt = Date.now();

          // O nativo já entregou no tamanho do contrato, então o aspect real
          // aparece aqui. Em 21:9 o bitrate alvo sobe junto (regra 4), e um
          // retarget para janela de outro tamanho recalcula de novo.
          if (frame.width !== plannedW || frame.height !== plannedH) {
            plannedW = frame.width;
            plannedH = frame.height;
            plan = planFor(qualityName, {
              width: frame.width,
              height: frame.height,
            });
            this.nativeWgcGovernor = new BitrateGovernor(plan);
            void this.applyNativeBitrate(plan.maxBitrate);
          }

          await writeFrame(bytes, frame.width, frame.height, format);
        } catch (e) {
          // O writer fechou: a publicação acabou. Parar de bombear frames é a
          // resposta certa — reiniciar a captura aqui (o que este catch fazia
          // ao confundir isto com formato recusado) só ressuscita um stream
          // que já morreu.
          if (e instanceof WriterClosedError) {
            this.nativeWgcWriter = undefined;
            window.soarapaDesktop?.logShareStats?.({
              nativeFrames: "writer fechado, parando o bombeamento",
            });
            return;
          }

          // NV12 recusado por esta build: volta o capturador para RGBA em vez
          // de deixar a transmissão morrer sem imagem.
          if (format === "nv12" && !nv12Rejected && nativeApi >= 2) {
            nv12Rejected = true;
            console.warn("[rtc] VideoFrame recusou NV12, caindo pra RGBA", e);
            window.soarapaDesktop?.logShareStats?.({
              nv12: "rejected",
              error: String(e),
            });
            window.soarapaDesktop?.switchNativeCapture?.(hwnd, {
              ...captureOptionsFor(plan),
              nv12: false,
            });
            return;
          }
          console.warn("[rtc] native frame write", e);
        }
      })();
    });

    const keepAlive = setInterval(() => {
      if (!this.nativeWgcWriter || !lastFrame) return;
      if (Date.now() - lastFrameAt < 1000) return;
      void writeFrame(
        lastFrame.data,
        lastFrame.width,
        lastFrame.height,
        lastFrame.format,
      ).catch(() => {
        // writer closed underneath us — stopNativeWgcShare clears the interval
      });
    }, 500);

    const unsubRetarget = window.soarapaDesktop!.onNativeRetarget?.(() => {
      window.soarapaDesktop?.retargetDone?.();
    });

    const unsubEnded = window.soarapaDesktop!.onNativeEnded?.(() => {
      void this.finishNativeWgcEnded();
    });

    // App 1.0.27 e anteriores não conhecem CaptureOptions: lá a captura é
    // `(hwnd, maxWidth)`, fica em 30fps e entrega RGBA. Mandar o objeto para
    // eles faria `Number({})` virar NaN e a transmissão nunca começar, então o
    // client se adapta em vez de exigir que todo mundo atualize junto.
    if (nativeApi >= 2) {
      window.soarapaDesktop!.startNativeCapture!(hwnd, captureOptionsFor(plan));
    } else {
      window.soarapaDesktop!.startNativeCapture!(hwnd, plan.maxWidth);
    }

    const localTrack = new LocalVideoTrack(generator, undefined, true);
    const pub = await room.localParticipant.publishTrack(localTrack, {
      source: Track.Source.ScreenShare,
      videoCodec: "h264",
      // Contrato regra 2: sob pressão cede a resolução, nunca o framerate.
      degradationPreference: plan.degradationPreference,
      simulcast: false,
      videoEncoding: {
        ...quality.encoding,
        maxBitrate: plan.maxBitrate,
        maxFramerate: plan.targetFps,
      },
    });

    this.nativeWgcPublication = pub;
    this.nativeWgcGovernor = new BitrateGovernor(plan);
    const encoderProbe = this.probeEncoder(localTrack, true);
    this.nativeWgcCleanup = () => {
      this.nativeWgcGovernor = undefined;
      clearInterval(keepAlive);
      clearTimeout(encoderProbe.first);
      clearInterval(encoderProbe.repeat);
      unsubFrame();
      unsubRetarget?.();
      unsubEnded?.();
    };

    if (wantAudio) {
      try {
        await this.publishNativeShareAudio(appId);
      } catch (e) {
        console.warn("[rtc] native share audio failed", e);
      }
    }

    this.#setScreenshare(true);
    this.sound.playSound("streamStart");
  }

  /**
   * Audio for a native share. Prefers per-process capture (only this app's
   * sound); falls back silently to system-wide loopback on Windows builds
   * without process loopback, so nobody ends up with no audio at all.
   */
  private async publishNativeShareAudio(appId: string | null | undefined) {
    if (await this.publishProcessAudio(appId)) return;
    await this.publishNativeLoopbackAudio();
  }

  /**
   * Per-process audio: the whole app, not just the captured window, so the
   * sound never cuts while LoL swaps the client for the match.
   * @returns whether it started.
   */
  private async publishProcessAudio(appId: string | null | undefined) {
    const room = this.room();
    const desktop = window.soarapaDesktop;
    if (!room || !desktop?.startProcessAudio) return false;

    const targets = await desktop.appAudioTargets?.(appId ?? null);
    if (!targets?.pids.length && !targets?.processNames.length) return false;

    const Generator = (
      globalThis as unknown as {
        MediaStreamTrackGenerator?: new (init: {
          kind: "audio";
        }) => MediaStreamTrack & { writable: WritableStream<AudioData> };
      }
    ).MediaStreamTrackGenerator;
    if (!Generator || typeof AudioData === "undefined") return false;

    if (!(await desktop.startProcessAudio(targets))) return false;

    const generator = new Generator({ kind: "audio" });
    const writer = generator.writable.getWriter();
    let timestampUs = 0;

    const unsub = desktop.onAudioSamples!((msg) => {
      void (async () => {
        try {
          const bytes =
            msg.data instanceof ArrayBuffer
              ? new Uint8Array(msg.data)
              : new Uint8Array(
                  (msg.data as Uint8Array).buffer,
                  (msg.data as Uint8Array).byteOffset,
                  (msg.data as Uint8Array).byteLength,
                );
          const samples = new Float32Array(
            bytes.buffer.slice(
              bytes.byteOffset,
              bytes.byteOffset + bytes.byteLength,
            ),
          );
          const frame = new AudioData({
            format: "f32",
            sampleRate: msg.sampleRate,
            numberOfFrames: msg.frames,
            numberOfChannels: msg.channels,
            timestamp: timestampUs,
            data: samples,
          });
          timestampUs += Math.round((msg.frames / msg.sampleRate) * 1_000_000);
          await writer.write(frame);
          frame.close();
        } catch (e) {
          console.warn("[rtc] process audio write", e);
        }
      })();
    });

    this.nativeWgcAudioTrack = generator;
    this.nativeWgcAudioCleanup = () => {
      unsub();
      desktop.stopProcessAudio?.();
      void writer.close().catch(() => undefined);
    };

    await room.localParticipant.publishTrack(generator, {
      source: Track.Source.ScreenShareAudio,
    });
    return true;
  }

  /**
   * Report which encoder WebRTC actually chose. `encoderImplementation` names
   * it outright — a MediaFoundation/NVENC name means the GPU is doing the work,
   * "OpenH264"/"libvpx" means software. Without this the only signal is Task
   * Manager's Video Encode counter, which cannot say why.
   *
   * Read straight off the RTCRtpSender: LiveKit's getSenderStats() drops
   * encoderImplementation and framesEncoded, which are the two fields that
   * matter here.
   */
  /**
   * Aplica um novo teto de bitrate no sender em curso.
   * `setParameters` sem renegociação: a publicação e o track seguem os mesmos,
   * então ninguém que está assistindo perde a imagem.
   */
  private async applyNativeBitrate(bps: number) {
    const sender = this.nativeWgcPublication?.videoTrack?.sender;
    if (!sender) return;
    try {
      const params = sender.getParameters();
      if (!params.encodings?.length) return;
      params.encodings[0].maxBitrate = bps;
      await sender.setParameters(params);
      window.soarapaDesktop?.logShareStats?.({
        bitrateTarget: Math.round(bps / 1000),
      });
    } catch (e) {
      console.warn("[rtc] bitrate apply", e);
    }
  }

  /**
   * @param track Track publicado.
   * @param adaptive Quando true, além de logar, alimenta o BitrateGovernor
   *   (contrato regra 3). Lê mais rápido do que loga: reagir a uma queda leva
   *   segundos, mas encher o app-share.log de linha igual não ajuda ninguém.
   */
  private probeEncoder(track: LocalVideoTrack, adaptive = false) {
    let lastFramesEncoded = 0;
    let reads = 0;

    const read = async () => {
      try {
        const sender = track.sender;
        if (!sender?.getStats) {
          console.warn("[rtc] encoder probe: no sender");
          window.soarapaDesktop?.logShareStats?.({
            encoder: "probe-unavailable",
          });
          return;
        }

        const report = await sender.getStats();
        let video: Record<string, unknown> | undefined;
        report.forEach((entry: Record<string, unknown>) => {
          if (entry.type === "outbound-rtp" && entry.kind === "video") {
            video = entry;
          }
        });
        if (!video) return;

        const framesEncoded = Number(video.framesEncoded ?? 0);
        const encoder = String(video.encoderImplementation ?? "unknown");
        const payload = {
          encoder,
          hardware:
            video.powerEfficientEncoder === true ||
            /mediafoundation|nvenc|d3d|qsv|vaapi|videotoolbox|amf|hardware/i.test(
              encoder,
            ),
          fps: Math.round(Number(video.framesPerSecond ?? 0)),
          resolution: `${video.frameWidth ?? "?"}x${video.frameHeight ?? "?"}`,
          framesSinceLast: framesEncoded - lastFramesEncoded,
          qualityLimitation: String(video.qualityLimitationReason ?? "none"),
        };
        lastFramesEncoded = framesEncoded;

        if (adaptive && this.nativeWgcGovernor) {
          let availableOutgoing: number | undefined;
          report.forEach((entry: Record<string, unknown>) => {
            if (
              entry.type === "candidate-pair" &&
              entry.availableOutgoingBitrate
            ) {
              availableOutgoing = Number(entry.availableOutgoingBitrate);
            }
          });
          const next = this.nativeWgcGovernor.observe(
            payload.qualityLimitation,
            availableOutgoing,
          );
          if (next !== null) {
            await this.applyNativeBitrate(next);
            console.info("[rtc] bitrate ->", Math.round(next / 1000), "kbps");
            window.soarapaDesktop?.logShareStats?.({
              ...payload,
              bitrateTarget: Math.round(next / 1000),
            });
            return;
          }
        }

        // Uma linha a cada ~30s, mesmo quando a leitura é de 3 em 3.
        reads += 1;
        if (adaptive && reads % 10 !== 1) return;

        console.info("[rtc] encoder", payload);
        window.soarapaDesktop?.logShareStats?.(payload);
      } catch (e) {
        console.warn("[rtc] encoder probe", e);
        window.soarapaDesktop?.logShareStats?.({
          encoder: "probe-failed",
          error: String(e),
        });
      }
    };

    // First read after the encoder has settled on an implementation.
    const first = setTimeout(() => void read(), 5_000);
    const repeat = setInterval(() => void read(), adaptive ? 3_000 : 30_000);
    return { first, repeat };
  }

  /** Windows system audio via Electron loopback (parallel silent screen grant). */
  private async publishNativeLoopbackAudio() {
    const room = this.room();
    if (!room || !window.soarapaDesktop) return;

    const screenId = await window.soarapaDesktop.getPrimaryScreenId?.();
    if (!screenId) {
      console.warn("[rtc] no screen id for loopback");
      return;
    }

    window.soarapaDesktop.forceNextScreenSource?.(screenId);
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: true,
    });
    try {
      stream.getVideoTracks().forEach((t) => t.stop());
      const audio = stream.getAudioTracks()[0];
      if (!audio) return;
      this.nativeWgcAudioTrack = audio;
      await room.localParticipant.publishTrack(audio, {
        source: Track.Source.ScreenShareAudio,
      });
    } catch (e) {
      stream.getTracks().forEach((t) => t.stop());
      throw e;
    }
  }

  private async finishNativeWgcEnded() {
    if (!this.nativeWgcPublication && !this.nativeWgcWriter) return;
    await this.stopNativeWgcShare();
    if (this.screenshare()) {
      this.#setScreenshare(false);
      this.sound.playSound("streamEnd");
    }
  }

  /**
   * @param clearFollow Whether to also drop the desktop app-follow state.
   *   False when called as pre-start cleanup: the picker has already registered
   *   the follow for the share we are about to start, and clearing it there
   *   silently killed the LoL client/match follow before its first frame.
   */
  private async stopNativeWgcShare(clearFollow = true) {
    this.nativeWgcCleanup?.();
    this.nativeWgcCleanup = undefined;
    window.soarapaDesktop?.stopNativeCapture?.();

    try {
      await this.nativeWgcWriter?.close();
    } catch {
      // ignore
    }
    this.nativeWgcWriter = undefined;

    const room = this.room();

    this.nativeWgcAudioCleanup?.();
    this.nativeWgcAudioCleanup = undefined;

    if (this.nativeWgcAudioTrack) {
      try {
        this.nativeWgcAudioTrack.stop();
        if (room) {
          await room.localParticipant.unpublishTrack(this.nativeWgcAudioTrack);
        }
      } catch {
        // ignore
      }
      this.nativeWgcAudioTrack = undefined;
    }

    const pub = this.nativeWgcPublication;
    this.nativeWgcPublication = undefined;
    if (pub?.track && room) {
      try {
        await room.localParticipant.unpublishTrack(pub.track);
      } catch {
        // already gone
      }
    }
    if (clearFollow) window.soarapaDesktop?.clearAppShare?.();
  }

  /**
   * Desktop app-share uses a canvas.captureStream() as the LiveKit track so
   * OS window switches never end the published track (no blink for viewers).
   * The real desktop capture only feeds a hidden <video> → canvas.
   */
  private bindAppShareFollow(localTrack: LocalTrackPublication) {
    this.appShareCleanup?.();
    this.appSharePublication = localTrack;

    const recover = async (reason: string) => {
      if (this.recoveringAppShare) return;
      if (!(await window.soarapaDesktop?.shouldContinueAppShare?.())) {
        await this.finishAppShareStop();
        return;
      }

      this.recoveringAppShare = true;
      try {
        console.info("[rtc] app-share recover:", reason);
        if (this.appShareBridge) {
          await this.switchAppShareInput();
        } else {
          await this.startAppShareBridge(localTrack);
          await this.switchAppShareInput();
        }
      } catch (e) {
        console.warn("[rtc] app-share recover failed", e);
        await this.finishAppShareStop();
      } finally {
        this.recoveringAppShare = false;
        window.soarapaDesktop?.retargetDone?.();
      }
    };

    const unsubRetarget = window.soarapaDesktop?.onRetarget?.(() => {
      void recover("retarget");
    });

    this.appShareCleanup = () => {
      unsubRetarget?.();
    };
  }

  private stopAppShareBridge() {
    if (this.appShareDrawHandle) {
      cancelAnimationFrame(this.appShareDrawHandle);
      this.appShareDrawHandle = 0;
    }
    try {
      this.appShareInputStream?.getTracks().forEach((t) => t.stop());
    } catch {
      // ignore
    }
    this.appShareInputStream = undefined;
    if (this.appShareVideo) {
      this.appShareVideo.srcObject = null;
      this.appShareVideo = undefined;
    }
    this.appShareCanvas = undefined;
    this.appShareBridge = false;
    this.appSharePublication = undefined;
  }

  /**
   * Clone the live desktop track into a hidden video→canvas pipeline, then
   * publish the canvas track. Stopping/replacing the OS capture no longer
   * ends what LiveKit (and viewers) see.
   */
  private async startAppShareBridge(publication: LocalTrackPublication) {
    const deskTrack = publication.videoTrack?.mediaStreamTrack;
    if (!deskTrack || this.appShareBridge) return;

    const clone = deskTrack.clone();
    const input = new MediaStream([clone]);

    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.setAttribute("playsinline", "true");
    video.srcObject = input;
    await video.play();

    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d", { alpha: false, desynchronized: true });
    if (!ctx) {
      clone.stop();
      throw new Error("canvas unsupported");
    }

    const draw = (now: number) => {
      this.appShareDrawHandle = requestAnimationFrame(draw);
      // Cap paint to ~30fps (monitors at 120/144Hz were over-drawing for free).
      if (now - this.appShareLastDraw < 33) return;
      this.appShareLastDraw = now;
      if (video.readyState >= 2 && video.videoWidth > 0) {
        if (
          canvas.width !== video.videoWidth ||
          canvas.height !== video.videoHeight
        ) {
          canvas.width = video.videoWidth;
          canvas.height = video.videoHeight;
        }
        ctx.drawImage(video, 0, 0);
      }
    };
    this.appShareDrawHandle = requestAnimationFrame(draw);

    const canvasStream = canvas.captureStream(30);
    const canvasTrack = canvasStream.getVideoTracks()[0];
    if (!canvasTrack || !publication.videoTrack) {
      cancelAnimationFrame(this.appShareDrawHandle);
      clone.stop();
      throw new Error("canvas track missing");
    }

    // Replace LiveKit output with canvas. LiveKit may stop `deskTrack`, but
    // the clone keeps feeding the video element.
    await publication.videoTrack.replaceTrack(canvasTrack);

    this.appShareVideo = video;
    this.appShareCanvas = canvas;
    this.appShareInputStream = input;
    this.appSharePublication = publication;
    this.appShareBridge = true;

    const onInputEnded = () => {
      void this.bindAppShareFollowRecoverFromInput();
    };
    clone.addEventListener("ended", onInputEnded);
  }

  private async bindAppShareFollowRecoverFromInput() {
    if (this.recoveringAppShare) return;
    if (!(await window.soarapaDesktop?.shouldContinueAppShare?.())) {
      await this.finishAppShareStop();
      return;
    }
    this.recoveringAppShare = true;
    try {
      console.info("[rtc] app-share recover: input-ended");
      await this.switchAppShareInput();
    } catch (e) {
      console.warn("[rtc] app-share input recover failed", e);
      await this.finishAppShareStop();
    } finally {
      this.recoveringAppShare = false;
      window.soarapaDesktop?.retargetDone?.();
    }
  }

  /** Swap only the hidden capture feeding the canvas — publication stays up. */
  private async switchAppShareInput() {
    if (!window.soarapaDesktop) throw new Error("not desktop");
    if (!this.appShareVideo) throw new Error("bridge not started");

    window.soarapaDesktop.prepareSilentAppShare();
    const found = await window.soarapaDesktop.waitForAppWindow();
    if (!found) throw new Error("no app window to follow");

    window.soarapaDesktop.prepareSilentAppShare();
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: false,
    });
    const track = stream.getVideoTracks()[0];
    if (!track) {
      stream.getTracks().forEach((t) => t.stop());
      throw new Error("no video in display media");
    }

    const previous = this.appShareInputStream;
    this.appShareVideo.srcObject = stream;
    try {
      await this.appShareVideo.play();
    } catch {
      // autoplay edge cases — keep going, frames may arrive anyway
    }
    this.appShareInputStream = stream;

    track.addEventListener("ended", () => {
      void this.bindAppShareFollowRecoverFromInput();
    });

    // Stop previous capture after the new one is attached (canvas held last frame).
    try {
      previous?.getTracks().forEach((t) => t.stop());
    } catch {
      // ignore
    }

    this.#setScreenshare(true);
  }

  private async finishAppShareStop() {
    this.appShareCleanup?.();
    this.appShareCleanup = undefined;
    this.stopAppShareBridge();
    window.soarapaDesktop?.clearAppShare?.();

    const room = this.room();
    try {
      if (room?.localParticipant.isScreenShareEnabled) {
        await room.localParticipant.setScreenShareEnabled(false);
      }
    } catch {
      // already gone
    }

    if (this.screenshare()) {
      this.#setScreenshare(false);
      this.sound.playSound("streamEnd");
    }
  }

  resetLayout() {
    this.#setLayout();
  }

  toggleLayout(type: VoiceLayout) {
    this.#setLayout((l) => (l === type ? undefined : type));
  }

  trackId(t: TrackReferenceOrPlaceholder) {
    return `${t.source}_${t.participant.sid}`;
  }

  toggleFocus(t?: TrackReferenceOrPlaceholder) {
    const id = t ? this.trackId(t) : undefined;
    this.#setFocus(
      this.focusId() === id || this.vidTracks().length < 2 ? undefined : id,
    );
  }

  isFocus(t: TrackReferenceOrPlaceholder) {
    return this.trackId(t) === this.focusId();
  }

  focusTrack() {
    const id = this.focusId();
    return id
      ? this.vidTracks().find((t) => this.trackId(t) === id)
      : undefined;
  }

  toggleShowBar() {
    this.#setShowBar((s) => !s);
  }

  getConnectedUser(userId: string) {
    return this.room()?.getParticipantByIdentity(userId);
  }

  showCard(channel: Channel) {
    return (
      channel.isVoice &&
      (this.channel()?.id === channel.id ||
        channel.type === "TextChannel" ||
        !!channel.voiceParticipants.size)
    );
  }

  getMicrophoneTrack(): LocalTrackPublication | undefined {
    const track = this.room()?.localParticipant.getTrackPublication(
      Track.Source.Microphone,
    );
    return track;
  }

  get listenPermission() {
    return !!this.channel()?.havePermission("Listen");
  }

  get speakingPermission() {
    return !!this.channel()?.havePermission("Speak");
  }

  private onErr(e: unknown) {
    if ((e as Error).name !== "NotAllowedError")
      this.openModal({ type: "error2", error: e });
  }
}

const voiceContext = createContext<Voice>(null as unknown as Voice);

/**
 * Mount global voice context and room audio manager
 */
export function VoiceContext(props: { children: JSX.Element }) {
  const state = useState();
  const modals = useModals();
  const sound = useSound();
  const device = useDevice();
  const voice = new Voice(state.voice, modals, sound, device);

  return (
    <voiceContext.Provider value={voice}>
      <RoomContext.Provider value={voice.room}>
        <VoiceCallCardContext>{props.children}</VoiceCallCardContext>
        <InRoom>
          <RoomAudioManager />
        </InRoom>
      </RoomContext.Provider>
    </voiceContext.Provider>
  );
}

export const useVoice = () => useContext(voiceContext);
