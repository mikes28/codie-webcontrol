#ifndef COMAPI_H
#define COMAPI_H

#include <stdint.h>

#if !defined( PACK )
	#define PACK(decl) decl __attribute__((__packed__))
#endif

typedef enum {
	ComApi_Route_App = 0x0u,
	ComApi_Route_Mcu = 0x1,
	ComApi_Route_Ble = 0x2,
	ComApi_Route_Broadcast = 0x3,
	// some helpers below...
	ComApi_Route_SourceApp = ComApi_Route_App,
	ComApi_Route_SourceMcu = ComApi_Route_Mcu,
	ComApi_Route_SourceBle = ComApi_Route_Ble,
	ComApi_Route_DestApp = (ComApi_Route_App<<2),
	ComApi_Route_DestMcu = (ComApi_Route_Mcu<<2),
	ComApi_Route_DestBle = (ComApi_Route_Ble<<2),
	ComApi_Route_DestBroadcast = (ComApi_Route_Broadcast<<2)
} comApi_route_t;

#define ComApi_RoutePosInInfoByte 4
#define ComApi_RouteDestinationPosInInfoByte (ComApi_RoutePosInInfoByte+2)
#define ComApi_RouteSourcePosInInfoByte (ComApi_RoutePosInInfoByte)

typedef enum {
	// general commands
	ComApi_Cmd_Null = 0u,	///< marks empty command, do not use (unless you have REASONS)
	ComApi_Cmd_Echo,
	ComApi_Cmd_HeartBeat,

	_ComApi_Cmd_GeneralImplementedListEndPos,	// WARNING! Check section overflow!
	_ComApi_Cmd_McuSectionStart = 0x1060u,

	// MCU commands
	ComApi_Cmd_Mcu_DriveSpeed = _ComApi_Cmd_McuSectionStart,
	ComApi_Cmd_Mcu_DriveDistance,
	ComApi_Cmd_Mcu_DriveTurn,
	ComApi_Cmd_Mcu_SonarGetRange,
	ComApi_Cmd_Mcu_SpeakBeep,
	ComApi_Cmd_Mcu_LedSetColor,
	ComApi_Cmd_Mcu_LedStartAnim,
	ComApi_Cmd_Mcu_AppConnected,
	ComApi_Cmd_Mcu_AppDisconnected,
	ComApi_Cmd_Mcu_BatteryGetSoc,
	ComApi_Cmd_Mcu_LightSenseGetRaw,
	ComApi_Cmd_Mcu_LineGetRaw,
	ComApi_Cmd_Mcu_MicGetRaw,
	ComApi_Cmd_Mcu_SwitchToBootloader,
	ComApi_Cmd_Mcu_BatteryGetVoltage,

	_ComApi_Cmd_McuImplementedListEndPos,	// WARNING! Check section overflow!
	_ComApi_Cmd_BleSectionStart = 0x4394u,

	// BLE commands
	ComApi_Cmd_Ble_McuDfuPrepare = _ComApi_Cmd_BleSectionStart,
	ComApi_Cmd_Ble_McuDfuWriteBin,
	ComApi_Cmd_Ble_McuDfuWriteBinDone,

	_ComApi_Cmd_BleImplementedListEndPos,	// WARNING! Check section overflow!
	_ComApi_Cmd_AppSectionStart = 0x64feu,

	// Client App commands
	//ComApi_Cmd_App_xxx = _ComApi_Cmd_AppSectionStart,

	_ComApi_Cmd_AppImplementedListEndPos	// WARNING! Check section overflow!
} comApi_cmdId_t;

typedef PACK( struct {
	uint16_t length;
	uint8_t data[];
}) comApi_cmdArg_t;

typedef PACK( struct {
	uint8_t info;
	uint16_t seq;
	uint16_t cmdId;
	comApi_cmdArg_t arg;
}) comApi_packet_t;

/// data[] at end doesn't add to size, packet type can be used as packetHead
typedef comApi_packet_t comApi_packetHead_t;

#endif // COMAPI_H
