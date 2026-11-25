@echo off
rem Cau hinh rieng cua ban cai dat nay. Chep thanh local.cmd (khong dua vao git) roi sua.
rem Hai ban tren cung mot may phai khac nhau o TOOL_PREFIX va TOOL_IMAGE / MAIN_IMAGE
rem (prefix = ten volume, mang, container: khac prefix thi khong dung chung du lieu).
rem Muon chay hai ban CUNG LUC thi GATE_PORT va TOOL_MANAGER_PORT cung phai khac.
set "TOOL_PREFIX=congty"
set "GATE_PORT=3454"
set "TOOL_MANAGER_PORT=3470"
set "TOOL_IMAGE=congty-tools:dev"
set "MAIN_IMAGE=congty-dsh-main:dev"
set "PROXY_IMAGE=congty-egress-proxy:dev"
rem Lan dau: de trong = tao ban sach; hoac duong dan runtime Windows cu de chep du lieu sang.
set "RUNTIME_DIR="
rem Ma nguon DeepSeek Harness (chi doc) de build image.
set "DSH_SOURCE=E:\Company\deepseek-harness"
rem Ban sach: volume co san mo hinh nhung de chep (chi doc thu muc .docshield/models); de trong = khong chep.
set "MODEL_FROM=docshield-storage"
rem Han muc dia moi nguoi (MB).
set "TOOL_QUOTA_MB=1024"
rem Dich noi bo duy nhat egress-proxy cho di (HTTP thuong): service remove-ai-marks (tools-local\start-watermarks.cmd). De trong = tat.
set "EGRESS_LOCAL_ALLOW=host.docker.internal:8765"
rem Project 3: tu bat agent xu ly phieu (project3\worker.py) cung start.cmd: 1 = bat, de trong = tat.
set "P3_WORKER="
rem Model cua agent (provider DSH + model). nien-router = 9Router; ollama-local + qwen3:8b = may nay (cham).
set "P3_PROVIDER=nien-router"
set "P3_RUN_MODEL=gemini/gemini-3-flash-preview"
rem 1 = agent dung dung model cua phien chatbot da tao phieu (khong ghi thi dung P3_RUN_MODEL); de trong = luon dung P3_RUN_MODEL.
set "P3_MODEL_FROM_TICKET="
