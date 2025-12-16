CC = emcc

SERIAL_DIR = submodule/wb-mqtt-serial
JSONCPP_DIR = submodule/valijson/thirdparty/jsoncpp-1.9.4

WASM_DIR = wasm
ASSETS_DIR = $(WASM_DIR)/assets
PROTOCOLS_DIR = $(ASSETS_DIR)/protocols
TEMPLATES_DIR = $(ASSETS_DIR)/templates

INC = \
	.                       \
	$(SERIAL_DIR)/src       \
	$(WASM_DIR)/src         \

SRC = \
	$(SERIAL_DIR)/src/bcd_utils.cpp                            \
	$(SERIAL_DIR)/src/bin_utils.cpp                            \
	$(SERIAL_DIR)/src/crc16.cpp                                \
	$(SERIAL_DIR)/src/common_utils.cpp                         \
	$(SERIAL_DIR)/src/confed_device_schemas_map.cpp            \
	$(SERIAL_DIR)/src/confed_protocol_schemas_map.cpp          \
	$(SERIAL_DIR)/src/confed_schema_generator.cpp              \
	$(SERIAL_DIR)/src/config_merge_template.cpp                \
	$(SERIAL_DIR)/src/expression_evaluator.cpp                 \
	$(SERIAL_DIR)/src/file_utils.cpp                           \
	$(SERIAL_DIR)/src/json_common.cpp                          \
	$(SERIAL_DIR)/src/log.cpp                                  \
	$(SERIAL_DIR)/src/modbus_base.cpp                          \
	$(SERIAL_DIR)/src/modbus_ext_common.cpp                    \
	$(SERIAL_DIR)/src/modbus_common.cpp                        \
	$(SERIAL_DIR)/src/pollable_device.cpp                      \
	$(SERIAL_DIR)/src/register.cpp                             \
	$(SERIAL_DIR)/src/register_value.cpp                       \
	$(SERIAL_DIR)/src/register_handler.cpp                     \
	$(SERIAL_DIR)/src/serial_client.cpp                        \
	$(SERIAL_DIR)/src/serial_client_device_access_handler.cpp  \
	$(SERIAL_DIR)/src/serial_client_events_reader.cpp          \
	$(SERIAL_DIR)/src/serial_client_register_poller.cpp        \
	$(SERIAL_DIR)/src/serial_config.cpp                        \
	$(SERIAL_DIR)/src/serial_device.cpp                        \
	$(SERIAL_DIR)/src/serial_exc.cpp                           \
	$(SERIAL_DIR)/src/templates_map.cpp                        \
	$(SERIAL_DIR)/src/wb_registers.cpp                         \
	$(SERIAL_DIR)/src/write_channel_serial_client_task.cpp     \
	$(SERIAL_DIR)/src/devices/modbus_device.cpp                \
	$(SERIAL_DIR)/src/port/port.cpp                            \
	$(SERIAL_DIR)/src/port/feature_port.cpp                    \
	$(SERIAL_DIR)/src/rpc/rpc_config_handler.cpp               \
	$(SERIAL_DIR)/src/rpc/rpc_config.cpp                       \
	$(SERIAL_DIR)/src/rpc/rpc_device_handler.cpp               \
	$(SERIAL_DIR)/src/rpc/rpc_device_load_task.cpp             \
	$(SERIAL_DIR)/src/rpc/rpc_device_load_config_task.cpp      \
	$(SERIAL_DIR)/src/rpc/rpc_device_set_task.cpp              \
	$(SERIAL_DIR)/src/rpc/rpc_device_probe_task.cpp            \
	$(SERIAL_DIR)/src/rpc/rpc_exception.cpp                    \
	$(SERIAL_DIR)/src/rpc/rpc_helpers.cpp                      \
	$(SERIAL_DIR)/src/rpc/rpc_port_scan_serial_client_task.cpp \
	$(WASM_DIR)/src/wasm_port.cpp                              \
	$(WASM_DIR)/src/wasm_module.cpp                            \

JINJA_TEMPLATES = \
	$(wildcard $(SERIAL_DIR)/templates/config-map*.json.jinja) \
	$(wildcard $(SERIAL_DIR)/templates/config-wb-*.json.jinja) \

OPT = \
	-fexceptions                                    \
	-lembind                                        \
	-sASYNCIFY                                      \
	-sASYNCIFY_IMPORTS=["emscripten_asm_const_int"] \

TEMPLATES = $(JINJA_TEMPLATES:.json.jinja=.json)

all: templates
# copy assets
	mkdir -p $(PROTOCOLS_DIR)
	cp $(SERIAL_DIR)/protocols/modbus.schema.json $(PROTOCOLS_DIR)
	cp $(SERIAL_DIR)/groups.json $(ASSETS_DIR)
	cp $(SERIAL_DIR)/wb-mqtt-serial-confed-common.schema.json $(ASSETS_DIR)
	cp $(SERIAL_DIR)/wb-mqtt-serial-ports.schema.json $(ASSETS_DIR)
	cp $(SERIAL_DIR)/wb-mqtt-serial-device-template.schema.json $(ASSETS_DIR)
# fix include
	cp -r $(JSONCPP_DIR)/include/json wblib/
# build module
	$(CC) -v -O3 $(addprefix -I, $(INC)) $(SRC) wblib/static/wblib.a -o $(WASM_DIR)/public/module.js --preload-file $(ASSETS_DIR)@/ $(OPT)

templates: $(TEMPLATES)
	cp $(SERIAL_DIR)/templates/config-map*.json $(TEMPLATES_DIR)
	cp $(SERIAL_DIR)/templates/config-wb-*.json $(TEMPLATES_DIR)
	grep -r '"deprecated"' $(TEMPLATES_DIR) | grep 'true' | awk -F ':' '{print $$1}' | xargs rm

$(TEMPLATES): %.json: %.json.jinja
	mkdir -p $(TEMPLATES_DIR)
	j2 -o $(TEMPLATES_DIR)/$(notdir $@) $<
