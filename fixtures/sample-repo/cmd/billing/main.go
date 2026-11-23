package main

import (
	"context"
	"net/http"

	stripe "github.com/stripe/stripe-go/v78"
	"github.com/stripe/stripe-go/v78/customer"
	"github.com/supabase-community/supabase-go"
	openai "github.com/sashabaranov/go-openai"
	twilio "github.com/twilio/twilio-go"
	twapi "github.com/twilio/twilio-go/rest/api/v2010"
)

func main() {
	ctx := context.Background()
	_ = ctx

	// Legacy Stripe Charges flow
	chargeParams := &stripe.ChargeParams{}
	chargeParams.SetSource("tok_visa")
	sc := stripe.NewClient("sk_test")
	_ = sc

	iter := customer.List(&stripe.CustomerListParams{})
	for iter.Next() {
		_ = iter.Customer()
	}

	twilioClient := twilio.NewRestClient()
	msgParams := &twapi.CreateMessageParams{}
	msgParams.SetFrom("+15550100")
	twilioClient.Api.CreateMessage(msgParams)

	oa := openai.NewClient("sk-test")
	_, _ = oa.CreateChatCompletion(ctx, openai.ChatCompletionRequest{
		Model: openai.GPTTextDavinci003,
	})

	sb, _ := supabase.NewClient("https://demo.supabase.co", "key", nil)
	_, _, _ = sb.From("users").Select("*", "123", false).Execute()

	// Raw HTTP call to a sunset endpoint
	req, _ := http.NewRequest("POST", "https://api.openai.com/v1/edits", nil)
	req.Header.Set("Authorization", "Bearer sk-test")
	_ = http.DefaultClient.Do(req)
}
